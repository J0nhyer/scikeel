#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_rejects_untrusted_roots_and_duplicate_project_authority() {
        let good=serde_json::json!({"schema":1,"instanceId":"user-a","generation":1,
            "workspaceDir":"/tenant/workspace","stateDir":"/tenant/state","home":"/tenant/home","scratchDir":"/tenant/scratch"});
        assert!(parse_manifest(&serde_json::to_vec(&good).unwrap()).is_ok());
        for patch in [serde_json::json!({"workspaceDir":"/"}),serde_json::json!({"stateDir":"/tenant/workspace/state"}),
            serde_json::json!({"home":"/peer/../home"}),serde_json::json!({"generation":0}),serde_json::json!({"command":"exec"})] {
            let mut bad=good.clone();for (key,value) in patch.as_object().unwrap() {bad[key]=value.clone();}
            assert!(parse_manifest(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    #[test]
    fn file_dispatch_keeps_descriptor_policy_for_reads_writes_and_symlink_escapes() {
        let root=std::env::temp_dir().join(format!("scikeel-file-rpc-{}",std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let policy=osd_core::file_policy::ManagedFilePolicy::new("a".into(),1,vec![("workspace".into(),root.clone())]).unwrap();
        assert!(dispatch(&policy,serde_json::json!({"operation":"write","root":"workspace","path":"owned.txt","text":"owned"})).is_ok());
        let read=dispatch(&policy,serde_json::json!({"operation":"read","root":"workspace","path":"owned.txt"})).unwrap();
        assert_eq!(read["text"],"owned");
        std::os::unix::fs::symlink("/etc/passwd",root.join("escape")).unwrap();
        for request in [serde_json::json!({"operation":"read","root":"workspace","path":"escape"}),
            serde_json::json!({"operation":"read","root":"workspace","path":"../peer"}),
            serde_json::json!({"operation":"read","root":"state","path":"secret"}),
            serde_json::json!({"operation":"exec","root":"workspace","path":"owned.txt"}),
            serde_json::json!({"operation":"read","root":"workspace","path":"owned.txt","command":"evil"})] {
            assert!(dispatch(&policy,request).is_err());
        }
        std::fs::remove_file(root.join("escape")).unwrap();std::fs::remove_file(root.join("owned.txt")).unwrap();std::fs::remove_dir(root).unwrap();
    }
}
use std::{fs::File,io::{Read,Write},os::{fd::{AsRawFd,FromRawFd},unix::fs::MetadataExt},path::{Component,Path,PathBuf}};
use osd_core::file_policy::ManagedFilePolicy;
use serde_json::{json,Value};

const MANIFEST:&str="/opt/scikeel/tenant.json";
fn canonical(value:&Value)->Result<PathBuf,String> {
    let text=value.as_str().ok_or("invalid managed path")?;let path=PathBuf::from(text);
    if !path.is_absolute() || text=="/" || text.ends_with('/') || text.contains('\0') || text.contains('\\') ||
        path.components().any(|part|!matches!(part,Component::RootDir|Component::Normal(_))) ||
        path.components().collect::<PathBuf>().to_string_lossy()!=text {return Err("invalid managed path".into());}
    Ok(path)
}
fn identifier(value:&Value)->bool {value.as_str().is_some_and(|text|!text.is_empty() && text.len()<=64 &&
    text.bytes().all(|byte|byte.is_ascii_alphanumeric() || byte==b'-' || byte==b'_'))}
fn parse_manifest(bytes:&[u8])->Result<Value,String> {
    if bytes.len()>65536 {return Err("managed manifest too large".into());}
    let value:Value=serde_json::from_slice(bytes).map_err(|_|"invalid managed manifest")?;
    let keys=["schema","instanceId","generation","workspaceDir","stateDir","home","scratchDir"];
    let object=value.as_object().ok_or("invalid managed manifest")?;
    if object.len()!=keys.len() || object.keys().any(|key|!keys.contains(&key.as_str())) || value["schema"]!=1 ||
        !identifier(&value["instanceId"]) || value["generation"].as_u64().is_none_or(|generation|generation==0 || generation>9_007_199_254_740_991) {
        return Err("invalid managed manifest".into());
    }
    let roots=["workspaceDir","stateDir","home","scratchDir"].iter().map(|key|canonical(&value[key])).collect::<Result<Vec<_>,_>>()?;
    if roots.iter().enumerate().any(|(i,path)|roots.iter().enumerate().any(|(j,other)|i!=j && path.starts_with(other))) {
        return Err("overlapping managed roots".into());
    }Ok(value)
}
pub fn manifest()->Result<Value,String> {
    let path=Path::new(MANIFEST);
    for parent in path.ancestors() {
        let info=std::fs::symlink_metadata(parent).map_err(|_|"managed manifest unavailable")?;
        if info.file_type().is_symlink() || info.uid()!=0 || info.mode()&0o022!=0 {return Err("untrusted managed manifest".into());}
    }
    let root=File::open("/").map_err(|_|"managed root unavailable")?;
    #[repr(C)] struct How {flags:u64,mode:u64,resolve:u64}
    let how=How {flags:(libc::O_RDONLY|libc::O_CLOEXEC|libc::O_NONBLOCK) as u64,mode:0,resolve:0x08|0x02|0x04};
    let name=std::ffi::CString::new(&MANIFEST[1..]).unwrap();
    let descriptor=unsafe {libc::syscall(libc::SYS_openat2,root.as_raw_fd(),name.as_ptr(),&how,std::mem::size_of::<How>())};
    if descriptor<0 {return Err("secure managed manifest unavailable".into());}
    let file=unsafe {File::from_raw_fd(descriptor as i32)};
    let info=file.metadata().map_err(|_|"managed manifest unavailable")?;
    if !info.is_file() || info.uid()!=0 || info.mode()&0o022!=0 || info.len()>65536 {return Err("untrusted managed manifest".into());}
    let mut bytes=Vec::new();file.take(65537).read_to_end(&mut bytes).map_err(|_|"managed manifest unavailable")?;
    parse_manifest(&bytes)
}
pub fn policy(value:&Value)->Result<ManagedFilePolicy,String> {
    ManagedFilePolicy::new(value["instanceId"].as_str().ok_or("invalid managed identity")?.into(),
        value["generation"].as_u64().ok_or("invalid managed generation")?,
        vec![("workspace".into(),canonical(&value["workspaceDir"])?)])
        .map_err(|_|"secure managed workspace unavailable".into())
}
fn dispatch(policy:&ManagedFilePolicy,value:Value)->Result<Value,String> {
    let object=value.as_object().ok_or("invalid file operation")?;
    if object.keys().any(|key|!["operation","root","path","text"].contains(&key.as_str())) || value["root"]!="workspace" {
        return Err("invalid file operation".into());
    }
    let path=value["path"].as_str().ok_or("invalid file path")?;
    let result=match value["operation"].as_str() {
        Some("read") if !object.contains_key("text")=> {
            let bytes=policy.read("workspace",path,2*1024*1024).map_err(|_|"file read denied")?;
            json!({"text":String::from_utf8(bytes).map_err(|_|"file is not UTF-8")?})
        },
        Some("write")=> {
            let text=value["text"].as_str().ok_or("invalid file content")?;
            if text.len()>2*1024*1024 {return Err("file content too large".into());}
            policy.write_atomic("workspace",path,text.as_bytes()).map_err(|_|"file write denied")?;json!({"written":true})
        },
        Some("list") if !object.contains_key("text")=>json!({"entries":policy.list("workspace",path,1000).map_err(|_|"file list denied")?}),
        Some("mkdir") if !object.contains_key("text")=> {policy.mkdir("workspace",path).map_err(|_|"directory creation denied")?;json!({"created":true})},
        _=>return Err("unsupported file operation".into()),
    };Ok(result)
}
pub fn file_rpc()->Result<(),String> {
    let trusted=manifest()?;let policy=policy(&trusted)?;
    let mut bytes=Vec::new();std::io::stdin().take(4*1024*1024+1).read_to_end(&mut bytes).map_err(|_|"file input unavailable")?;
    if bytes.len()>4*1024*1024 {return Err("file input too large".into());}
    let request=serde_json::from_slice(&bytes).map_err(|_|"invalid file request")?;
    let response=dispatch(&policy,request)?;
    std::io::stdout().write_all(&serde_json::to_vec(&response).map_err(|_|"invalid file response")?).map_err(|_|"file output unavailable".into())
}
