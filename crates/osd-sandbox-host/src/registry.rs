use crate::protocol::{digest, identifier, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status { Registered, Starting, Ready, Stopped, Unavailable }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Account {
    pub instance_id: String,
    pub user_id: String,
    pub generation: u64,
    pub status: Status,
    pub address: u8,
    pub project_id: u32,
    pub image_digest: Option<String>,
    pub last_stopped_generation: Option<u64>,
}
#[derive(Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry { pub accounts: BTreeMap<String, Account> }
impl Registry {
    pub fn validate(&self) -> Result<()> {
        if self.accounts.len() > 253 { return Err("registry_full"); }
        let mut users=std::collections::HashSet::new();
        let mut addresses=std::collections::HashSet::new();
        let mut projects=std::collections::HashSet::new();
        for (key,a) in &self.accounts {
            if key != &a.instance_id || !identifier(key,64) || !identifier(&a.user_id,64)
                || a.generation==0 || a.generation>9_007_199_254_740_991 || !(2..=254).contains(&a.address)
                || a.project_id<10_000 || !users.insert(&a.user_id) || !addresses.insert(a.address)
                || !projects.insert(a.project_id) || a.image_digest.as_ref().is_some_and(|v| !digest(v))
                || a.last_stopped_generation.is_some_and(|v| v==0 || v>=a.generation) {
                return Err("invalid_registry");
            }
        }
        Ok(())
    }
    pub fn register(&mut self, instance_id: &str, user_id: &str) -> Result<Account> {
        if !identifier(instance_id,64) || !identifier(user_id,64) { return Err("invalid_binding"); }
        if let Some(a)=self.accounts.get(instance_id) {
            return if a.user_id == user_id { Ok(a.clone()) } else { Err("foreign_instance") };
        }
        if self.accounts.values().any(|a| a.user_id==user_id) { return Err("foreign_user"); }
        let address=(2..=254).find(|v| self.accounts.values().all(|a| a.address != *v)).ok_or("registry_full")?;
        let project_id=10_000+u32::from(address);
        let a=Account { instance_id:instance_id.into(), user_id:user_id.into(), generation:1,
            status:Status::Registered,address,project_id,image_digest:None,last_stopped_generation:None };
        self.accounts.insert(instance_id.into(),a.clone()); Ok(a)
    }
    pub fn account(&self, instance_id: &str) -> Result<&Account> { self.accounts.get(instance_id).ok_or("unknown_instance") }
    pub fn begin_start(&mut self, instance_id: &str, generation: u64, image_digest: &str) -> Result<Account> {
        let a=self.accounts.get_mut(instance_id).ok_or("unknown_instance")?;
        if a.generation != generation { return Err("stale_generation"); }
        if !digest(image_digest) { return Err("invalid_image"); }
        if a.status==Status::Starting || a.status==Status::Ready { return Err("already_started"); }
        a.status=Status::Starting; a.image_digest=Some(image_digest.into()); Ok(a.clone())
    }
    pub fn mark_ready(&mut self, instance_id: &str, generation: u64) -> Result<()> {
        let a=self.accounts.get_mut(instance_id).ok_or("unknown_instance")?;
        if a.generation!=generation || a.status!=Status::Starting { return Err("stale_generation"); }
        a.status=Status::Ready; Ok(())
    }
    pub fn mark_stopped(&mut self, instance_id: &str, generation: u64, failed: bool) -> Result<()> {
        let a=self.accounts.get_mut(instance_id).ok_or("unknown_instance")?;
        if a.last_stopped_generation==Some(generation) { return Ok(()); }
        if a.generation!=generation { return Err("stale_generation"); }
        let next=a.generation.checked_add(1).filter(|v| *v<=9_007_199_254_740_991).ok_or("generation_exhausted")?;
        a.last_stopped_generation=Some(generation); a.generation=next;
        a.status=if failed { Status::Unavailable } else { Status::Stopped }; Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bindings_cannot_change_and_users_get_distinct_quota_and_network_identity() {
        let mut r=Registry::default();let a=r.register("user-a","a").unwrap();let b=r.register("user-b","b").unwrap();
        assert_ne!(a.address,b.address);assert_ne!(a.project_id,b.project_id);
        assert!(r.register("user-a","b").is_err());assert!(r.register("other","a").is_err());
        assert!(r.account("unknown").is_err());assert!(r.validate().is_ok());
    }
    #[test]
    fn generation_invalidates_old_starts_and_stop_is_idempotent() {
        let mut r=Registry::default();r.register("a","a").unwrap();let digest=format!("sha256:{}","a".repeat(64));
        r.begin_start("a",1,&digest).unwrap();r.mark_ready("a",1).unwrap();
        assert!(r.begin_start("a",1,&digest).is_err());r.mark_stopped("a",1,false).unwrap();
        r.mark_stopped("a",1,false).unwrap();assert_eq!(r.account("a").unwrap().generation,2);
        assert!(r.begin_start("a",1,&digest).is_err());r.begin_start("a",2,&digest).unwrap();
        r.mark_stopped("a",2,true).unwrap();assert_eq!(r.account("a").unwrap().status,Status::Unavailable);
        assert!(r.mark_ready("a",2).is_err());assert!(r.validate().is_ok());
    }
}
