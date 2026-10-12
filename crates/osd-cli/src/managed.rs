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
    struct ManagedFixture {
        base: PathBuf,
        workspace: PathBuf,
        env: osd_core::Env,
    }

    impl ManagedFixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "scikeel-managed-startup-{}", osd_core::runtime::random_hex(8)
            ));
            let workspace = base.join("workspace");
            for name in ["workspace", "state", "home", "scratch"] {
                std::fs::create_dir_all(base.join(name)).unwrap();
            }
            let value = json!({"schema": 1, "instanceId": "user-a", "generation": 1,
                "workspaceDir": workspace, "stateDir": base.join("state"),
                "home": base.join("home"), "scratchDir": base.join("scratch")});
            let trusted = parse_manifest(&serde_json::to_vec(&value).unwrap()).unwrap();
            let env = osd_core::Env::new(base.join("state"), base.join("resources"), None, "test".into())
                .with_managed_files(policy(&trusted).unwrap());
            Self { base, workspace, env }
        }
    }

    impl Drop for ManagedFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn startup_policy_supports_workspace_browsing_and_artifacts() {
        use osd_core::artifact_file::*;
        let fixture = ManagedFixture::new();
        std::fs::write(fixture.workspace.join("note.txt"), "owned artifact").unwrap();
        for root in [None, Some("workspace"), Some("base")] {
            assert_eq!(scope_root(&fixture.env, root).unwrap(), fixture.workspace);
            let preview = read_artifact(&fixture.env, "note.txt".into(), root.map(str::to_owned)).unwrap();
            assert_eq!(serde_json::to_value(preview).unwrap()["data"], "owned artifact");
            assert_eq!(list_dir(&fixture.env, "".into(), root.map(str::to_owned)).unwrap().len(), 1);
        }
        assert_eq!(resolve_artifact(&fixture.env, "note.txt").unwrap().as_deref(), Some("note.txt"));
        let peer = fixture.base.join("peer.txt");
        std::fs::write(&peer, "foreign").unwrap();
        std::os::unix::fs::symlink(&peer, fixture.workspace.join("escape")).unwrap();
        assert!(read_artifact(&fixture.env, "escape".into(), None).is_err());
        assert!(read_artifact(&fixture.env, "../peer.txt".into(), None).is_err());
        assert!(scope_root(&fixture.env, Some("account")).is_err());
        assert_eq!(dispatch(fixture.env.managed_files().unwrap(), json!({
            "operation": "read", "root": "workspace", "path": "note.txt"
        })).unwrap()["text"], "owned artifact");
    }

    #[test]
    fn startup_policy_supports_project_lifecycle() {
        use osd_core::project::*;
        let fixture = ManagedFixture::new();
        assert!(list_projects(&fixture.env).unwrap().is_empty());
        let project = create_project(&fixture.env, "Owned Study").unwrap();
        assert!(Path::new(&project.path).starts_with(&fixture.workspace));
        rename_project(&fixture.env, &project.id, "Renamed Study").unwrap();
        set_project_pinned(&fixture.env, &project.id, true).unwrap();
        let projects = list_projects(&fixture.env).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Renamed Study");
        assert!(projects[0].pinned);
        delete_project(&fixture.env, &project.id).unwrap();
        assert!(list_projects(&fixture.env).unwrap().is_empty());
    }

    #[test]
    fn startup_policy_supports_run_inventory_and_logs() {
        let fixture = ManagedFixture::new();
        let metadata = fixture.workspace.join("sessions/one/.openscience");
        std::fs::create_dir_all(metadata.join("logs")).unwrap();
        std::fs::write(metadata.join("runs.jsonl"), concat!(
            r#"{"runId":"run_owned","ts":1,"status":"ok","command":"python local.py","sessionId":"ses_owned","logHash":"abcd","code":[],"outputs":[]}"#,
            "\n"
        )).unwrap();
        std::fs::write(metadata.join("logs/abcd.txt"), "owned-log").unwrap();
        let page = osd_core::runs_index::query_runs_cmd(&fixture.env, Default::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].run_id, "run_owned");
        assert_eq!(osd_core::runs::list_runs(&fixture.env).unwrap().len(), 1);
        assert_eq!(osd_core::runs::read_run_log(&fixture.env, "abcd").unwrap(), "owned-log");
        assert!(osd_core::runs::read_run_log(&fixture.env, "../peer").is_err());
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
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"binary","offset":0,"bytes":[0,255]})).is_ok());
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"binary","offset":0,"bytes":[1]})).is_err());
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"binary","offset":1,"bytes":[1]})).is_err());
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"binary","offset":2,"bytes":[42]})).is_ok());
        let binary=dispatch(&policy,serde_json::json!({"operation":"readChunk","root":"workspace","path":"binary","offset":1,"limit":2})).unwrap();
        assert_eq!(binary["bytes"],serde_json::json!([255,42]));assert_eq!(binary["size"],3);
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"escape","offset":0,"bytes":[1]})).is_err());
        assert!(dispatch(&policy,serde_json::json!({"operation":"writeChunk","root":"workspace","path":"binary","offset":u64::MAX,"bytes":[1]})).is_err());
        assert!(dispatch(&policy,serde_json::json!({"operation":"remove","root":"workspace","path":"binary"})).is_ok());
        std::fs::remove_file(root.join("escape")).unwrap();std::fs::remove_file(root.join("owned.txt")).unwrap();std::fs::remove_dir(root).unwrap();
    }
}
use std::{fs::File,io::{Read,Write},os::{fd::{AsRawFd,FromRawFd},unix::fs::MetadataExt},path::{Component,Path,PathBuf}};
use osd_core::file_policy::{ManagedFilePolicy, WORKSPACE_ROOT};
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
        vec![(WORKSPACE_ROOT.into(),canonical(&value["workspaceDir"])?)])
        .map_err(|_|"secure managed workspace unavailable".into())
}
fn dispatch(policy:&ManagedFilePolicy,value:Value)->Result<Value,String> {
    let object=value.as_object().ok_or("invalid file operation")?;
    if object.keys().any(|key|!["operation","root","path","text","offset","limit","bytes"].contains(&key.as_str())) || value["root"]!=WORKSPACE_ROOT {
        return Err("invalid file operation".into());
    }
    let path=value["path"].as_str().ok_or("invalid file path")?;
    let allowed: &[&str] = match value["operation"].as_str() {
        Some("readChunk") => &["operation","root","path","offset","limit"],
        Some("writeChunk") => &["operation","root","path","offset","bytes"],
        Some("write") => &["operation","root","path","text"],
        _ => &["operation","root","path"],
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {return Err("invalid file fields".into());}
    let result=match value["operation"].as_str() {
        Some("readChunk") => {
            let offset=value["offset"].as_u64().ok_or("invalid chunk offset")?;
            let limit=value["limit"].as_u64().filter(|value|*value>0 && *value<=256*1024).ok_or("invalid chunk size")?;
            let (bytes,size)=policy.read_chunk("workspace",path,offset,limit as usize).map_err(|_|"file chunk read denied")?;
            json!({"bytes":bytes,"size":size,"offset":offset})
        },
        Some("writeChunk") => {
            let offset=value["offset"].as_u64().ok_or("invalid chunk offset")?;
            let values=value["bytes"].as_array().filter(|values|values.len()<=256*1024).ok_or("invalid chunk bytes")?;
            let bytes=values.iter().map(|value|value.as_u64().filter(|value|*value<=255).map(|value|value as u8).ok_or("invalid chunk byte")).collect::<Result<Vec<_>,_>>()?;
            policy.write_chunk("workspace",path,offset,&bytes).map_err(|_|"file chunk write denied")?;
            json!({"written":bytes.len(),"offset":offset})
        },
        Some("mkdirAll") => {policy.mkdir_all("workspace",path).map_err(|_|"directory creation denied")?;json!({"created":true})},
        Some("remove") => {policy.unlink("workspace",path).map_err(|_|"file removal denied")?;json!({"removed":true})},
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
