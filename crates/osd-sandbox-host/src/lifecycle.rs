use crate::protocol::Result;
use serde::Serialize;
use std::{fs, path::Path};

pub const MEMORY_HIGH:u64=640*1024*1024;
pub const MEMORY_MAX:u64=1024*1024*1024;
pub const SWAP_MAX:u64=128*1024*1024;
pub const PIDS_MAX:u64=256;
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Limits {pub memory_high:u64,pub memory_max:u64,pub swap_max:u64,pub pids_max:u64,
    pub cpu_quota:u64,pub cpu_period:u64,pub owned:bool}
fn decimal(v:&str)->Result<u64> {
    let v=v.trim();if v.is_empty() || !v.bytes().all(|c|c.is_ascii_digit()) {return Err("unbounded_controller");}
    v.parse().map_err(|_|"invalid_controller")
}
pub fn verify_limits(high:&str,max:&str,swap:&str,pids:&str,cpu:&str,owned:bool)->Result<Limits> {
    let fields:Vec<_>=cpu.split_whitespace().collect();if fields.len()!=2 {return Err("invalid_cpu_controller");}
    let limits=Limits {memory_high:decimal(high)?,memory_max:decimal(max)?,swap_max:decimal(swap)?,pids_max:decimal(pids)?,
        cpu_quota:decimal(fields[0])?,cpu_period:decimal(fields[1])?,owned};
    if limits.memory_high!=MEMORY_HIGH {return Err("memory_high_not_enforced");}
    if limits.memory_max!=MEMORY_MAX {return Err("memory_max_not_enforced");}
    if limits.swap_max!=SWAP_MAX {return Err("swap_not_enforced");}
    if limits.pids_max!=PIDS_MAX {return Err("pids_not_enforced");}
    if limits.cpu_quota==0 || limits.cpu_period==0 || limits.cpu_quota>limits.cpu_period {return Err("cpu_not_enforced");}
    if !owned {return Err("process_ownership_unverified");}Ok(limits)
}
fn process_belongs(root:&Path,content:&str)->bool {
    let Ok(relative)=root.strip_prefix("/sys/fs/cgroup") else {return false;};
    let expected=format!("/{}",relative.display());
    content.lines().any(|line|line.strip_prefix("0::").is_some_and(|path|path==expected || path.starts_with(&format!("{expected}/"))))
}
pub fn inspect_cgroup(root:&Path)->Result<Limits> {
    if !root.starts_with("/sys/fs/cgroup/system.slice") || root.file_name().is_none_or(|n|!n.to_string_lossy().starts_with("scikeel-tenant-")) {
        return Err("foreign_cgroup");
    }
    let read=|name:&str|fs::read_to_string(root.join(name)).map_err(|_|"controller_unavailable");
    let mut processes=Vec::new();
    fn descend(root:&Path,processes:&mut Vec<u32>,depth:usize)->Result<()> {
        if depth>8 {return Err("unexpected_cgroup_depth");}
        let content=fs::read_to_string(root.join("cgroup.procs")).map_err(|_|"controller_unavailable")?;
        for value in content.split_whitespace() {
            processes.push(value.parse().map_err(|_|"invalid_process_id")?);
            if processes.len()>256 {return Err("unbounded_process_tree");}
        }
        for entry in fs::read_dir(root).map_err(|_|"controller_unavailable")? {
            let entry=entry.map_err(|_|"controller_unavailable")?;
            if entry.file_type().map_err(|_|"controller_unavailable")?.is_dir() {descend(&entry.path(),processes,depth+1)?;}
        }Ok(())
    }
    descend(root,&mut processes,0)?;
    let owned=!processes.is_empty() && processes.iter().all(|pid| {
        fs::read_to_string(format!("/proc/{pid}/cgroup")).ok().is_some_and(|v|process_belongs(root,&v))
    });
    verify_limits(&read("memory.high")?,&read("memory.max")?,&read("memory.swap.max")?,&read("pids.max")?,&read("cpu.max")?,owned)
}
pub fn unit_name(instance_id:&str,generation:u64)->Result<String> {
    if !crate::protocol::identifier(instance_id,64) || generation==0 {return Err("invalid_unit_identity");}
    Ok(format!("scikeel-tenant-{instance_id}-g{generation}.service"))
}
pub fn unit_properties()->[String;8] {
    [format!("MemoryHigh={MEMORY_HIGH}"),format!("MemoryMax={MEMORY_MAX}"),format!("MemorySwapMax={SWAP_MAX}"),
        format!("TasksMax={PIDS_MAX}"),"CPUQuota=100%".into(),"KillMode=control-group".into(),
        "TimeoutStopSec=5s".into(),"Delegate=no".into()]
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proc_cgroup_membership_keeps_the_leading_slash_and_rejects_prefix_collisions() {
        let root=Path::new("/sys/fs/cgroup/system.slice/scikeel-tenant-a-g1.service");
        assert!(super::process_belongs(root,"0::/system.slice/scikeel-tenant-a-g1.service\n"));
        assert!(super::process_belongs(root,"0::/system.slice/scikeel-tenant-a-g1.service/child\n"));
        assert!(!super::process_belongs(root,"0::/system.slice/scikeel-tenant-a-g1.service-other\n"));
        assert!(!super::process_belongs(root,"0::/system.slice/scikeel-tenant-b-g1.service\n"));
    }
    #[test]
    fn readiness_requires_finite_exact_memory_swap_pids_cpu_and_owned_processes() {
        let verify=|max,swap,pids,cpu,owned|verify_limits("671088640",max,swap,pids,cpu,owned);
        assert!(verify("1073741824","134217728","256","100000 100000",true).is_ok());
        for (max,swap,pids,cpu,owned) in [("max","134217728","256","100000 100000",true),
            ("1073741824","max","256","100000 100000",true),("1073741824","134217728","max","100000 100000",true),
            ("1073741824","134217728","256","max 100000",true),("1073741824","134217728","256","200000 100000",true),
            ("1073741824","134217728","256","100000 100000",false)] {assert!(verify(max,swap,pids,cpu,owned).is_err());}
        assert!(verify_limits("","1073741824","134217728","256","100000 100000",true).is_err());
    }
    #[test]
    fn transient_units_have_fixed_limits_and_never_accept_extra_argv() {
        assert_eq!(unit_name("user-a",1).unwrap(),"scikeel-tenant-user-a-g1.service");
        assert!(unit_name("../peer",1).is_err());
        let props=unit_properties();assert!(props.contains(&"KillMode=control-group".to_string()));
        assert!(props.contains(&"Delegate=no".to_string()));assert_eq!(props.len(),8);
    }
}
