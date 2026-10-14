use crate::{protocol::Result,secure};
use serde::Deserialize;
use std::{fs::File,io::Read,path::{Component,Path,PathBuf}};
use sha2::{Digest,Sha256};

#[derive(Debug,Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Roots {pub instances:PathBuf,pub native:PathBuf,pub images:PathBuf}
#[derive(Debug,Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
pub struct Config {
    pub schema:u32,pub platform_uid:u32,pub platform_gid:u32,pub socket_path:PathBuf,
    pub state_dir:PathBuf,pub roots:Roots,pub runsc:PathBuf,pub runsc_sha256:String,
    pub quota_device:String,pub quota_bytes:u64,pub quota_inodes:u64,
    pub quota_backing_file:PathBuf,pub quota_capacity:u64,
    #[serde(default)] pub synthetic:bool,
}
fn path(p:&Path)->bool {
    p.is_absolute() && p!=Path::new("/") && p.components().all(|c| matches!(c,Component::RootDir|Component::Normal(_)))
        && !p.as_os_str().as_encoded_bytes().contains(&0)
}
impl Config {
    pub fn validate(&self)->Result<()> {
        let paths=[&self.roots.instances,&self.roots.native,&self.roots.images,&self.state_dir];
        if self.schema!=1 || self.platform_uid==0 || self.platform_gid==0 || !path(&self.socket_path)
            || !path(&self.runsc) || !self.quota_device.starts_with("/dev/") || self.quota_device.contains('\0')
            || !crate::protocol::digest(&format!("sha256:{}",self.runsc_sha256))
            || self.quota_bytes<64*1024*1024 || self.quota_bytes>16*1024*1024*1024 || self.quota_bytes%1024!=0
            || !path(&self.quota_backing_file) || self.quota_capacity<self.quota_bytes || self.quota_capacity>16*1024*1024*1024
            || self.quota_inodes<1024 || self.quota_inodes>1_000_000 {
            return Err("invalid_launcher_configuration");
        }
        for (i,p) in paths.iter().enumerate() {
            if !path(p) || paths.iter().enumerate().any(|(j,other)|i!=j && p.starts_with(other)) {
                return Err("overlapping_launcher_roots");
            }
        }
        if self.socket_path.starts_with(&self.roots.instances) || self.socket_path.starts_with(&self.roots.native)
            || self.runsc.starts_with(&self.roots.instances) || self.runsc.starts_with(&self.roots.native) {
            return Err("launcher_control_inside_tenant");
        }
        Ok(())
    }
    pub fn load(path:&Path)->Result<Self> {
        let bytes=secure::read_root_owned(path,65536).map_err(|_|"config_secure_open_failed")?;
        let config:Self=serde_json::from_slice(&bytes).map_err(|_|"invalid_launcher_configuration")?;
        config.validate()?;
        secure::root_owned(&config.state_dir,true).map_err(|_|"state_root_secure_open_failed")?;
        secure::root_owned(&config.roots.images,true).map_err(|_|"image_root_secure_open_failed")?;
        let mut binary=secure::root_owned(&config.runsc,false).map_err(|_|"runsc_secure_open_failed")?;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
        loop {let length=binary.read(&mut buffer).map_err(|_|"runsc_read_failed")?;if length==0 {break;}hash.update(&buffer[..length]);}
        if format!("{:x}",hash.finalize())!=config.runsc_sha256 {return Err("runsc_checksum_mismatch");}
        Ok(config)
    }
    pub fn sources(&self,account:&crate::registry::Account)->[PathBuf;6] {
        let instance=self.roots.instances.join(&account.instance_id);let native=self.roots.native.join(&account.user_id);
        [instance.join("workspace"),instance.join("state"),native.join("home"),native.join("claude-config"),native.join("codex-home"),instance.join("scratch")]
    }
    pub fn source_descriptors(&self,account:&crate::registry::Account)->Result<Vec<File>> {
        self.sources(account).iter().map(|p|secure::open(p,true)).collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Config {serde_json::from_value(serde_json::json!({"schema":1,"platformUid":1000,"platformGid":1000,
        "socketPath":"/run/scikeel/host.sock","stateDir":"/var/lib/scikeel/launcher","roots":{"instances":"/srv/platform/workers/instances",
        "native":"/srv/platform/cli-runtime/users","images":"/var/lib/scikeel/images"},"runsc":"/usr/local/lib/scikeel/runsc",
        "runscSha256":"a".repeat(64),"quotaDevice":"/dev/loop1","quotaBytes":2147483648u64,"quotaInodes":100000,"quotaBackingFile":"/var/lib/scikeel/tenant-data.img","quotaCapacity":4294967296u64})).unwrap()}
    #[test]
    fn fixed_roots_and_limits_exclude_tenant_control_and_path_collisions() {
        let mut c=fixture();assert!(c.validate().is_ok());
        c.roots.images=c.roots.native.join("images");assert!(c.validate().is_err());
        let mut c=fixture();c.platform_uid=0;assert!(c.validate().is_err());
        let mut c=fixture();c.runsc=c.roots.instances.join("runsc");assert!(c.validate().is_err());
        let mut c=fixture();c.quota_bytes=0;assert!(c.validate().is_err());
        let a=crate::registry::Registry::default().register("user-a","a").unwrap();
        assert_eq!(fixture().sources(&a)[0],PathBuf::from("/srv/platform/workers/instances/user-a/workspace"));
        assert!(!fixture().sources(&a).contains(&PathBuf::from("/srv/platform/cli-runtime/users/a")));
    }
}
