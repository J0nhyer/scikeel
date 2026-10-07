use crate::{config::Config,lifecycle::{self,Limits},network,protocol::Result,quota::{self,QuotaEvidence},registry::Account,secure};
use serde_json::{json,Value};
use std::{ffi::CString,fs::{self,OpenOptions},io::{Read,Write},os::{fd::AsRawFd,unix::fs::{OpenOptionsExt,PermissionsExt}},path::{Path,PathBuf},process::{Command,Stdio},time::{Duration,Instant}};

fn command(binary:&str,args:&[String],seconds:u64)->Result<()> {
    let mut child=Command::new(binary).args(args).env_clear().env("PATH","/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"host_command_unavailable")?;
    let deadline=Instant::now()+Duration::from_secs(seconds);
    loop {
        match child.try_wait().map_err(|_|"host_command_failed")? {
            Some(status)=>return if status.success() {Ok(())} else {Err("host_command_failed")},
            None if Instant::now()>=deadline=>{let _=child.kill();let _=child.wait();return Err("host_command_timeout");}
            _=>std::thread::sleep(Duration::from_millis(20)),
        }
    }
}
fn stage(config:&Config,account:&Account)->PathBuf {config.state_dir.join("bundles").join(format!("{}-g{}",account.instance_id,account.generation))}
fn container_id(account:&Account)->String {format!("scikeel-{}-g{}",account.instance_id,account.generation)}
fn unit_cgroup(account:&Account)->Result<PathBuf> {Ok(Path::new("/sys/fs/cgroup/system.slice").join(lifecycle::unit_name(&account.instance_id,account.generation)?))}
fn image(config:&Config,digest:&str)->Result<PathBuf> {
    if !crate::protocol::digest(digest) {return Err("invalid_image");}
    let base=config.roots.images.join(&digest[7..]);
    let manifest:Value=serde_json::from_slice(&secure::read_root_owned(&base.join("image-manifest.json"),65536)?).map_err(|_|"invalid_image")?;
    let ready:Value=serde_json::from_slice(&secure::read_root_owned(&base.join("ready.json"),4096)?).map_err(|_|"image_not_ready")?;
    if ready["schema"]!=1 || ready["imageDigest"]!=digest || manifest["schema"]!=1 || manifest["imageDigest"]!=digest
        || manifest["architecture"]!="linux/amd64" || manifest["name"]!="science-v1" {return Err("image_not_ready");}
    let expected=if config.synthetic {"probe"} else {"production"};
    if manifest["variant"]!=expected || (!config.synthetic && !manifest["testEntryPoint"].is_null()) {return Err("wrong_image_variant");}
    let root=base.join("rootfs");secure::root_owned(&root,true)?;Ok(root)
}
fn network_manifest(config:&Config,account:&Account)->Result<PathBuf> {
    network::verify(config,account)
}
pub fn preflight(config:&Config,account:&Account,digest:&str)->Result<()> {
    image(config,digest)?;
    quota::verify_backing_file(&config.quota_backing_file,&config.quota_device,config.quota_capacity)?;
    let sources=config.source_descriptors(account)?;
    quota::verify(&config.quota_device,account.project_id,config.quota_bytes,config.quota_inodes,&sources)?;
    network::preflight()?;
    let controllers=fs::read_to_string("/sys/fs/cgroup/cgroup.controllers").map_err(|_|"controllers_unavailable")?;
    if ["memory","pids","cpu"].iter().any(|v|!controllers.split_whitespace().any(|c|c==*v)) {return Err("controllers_unavailable");}
    let memory=fs::read_to_string("/proc/meminfo").map_err(|_|"host_reserve_unavailable")?;
    let available=memory.lines().find_map(|line|line.strip_prefix("MemAvailable:")?.split_whitespace().next()?.parse::<u64>().ok())
        .ok_or("host_reserve_unavailable")?;
    if available<600*1024+1024*1024 {return Err("host_reserve_insufficient");}
    Ok(())
}
fn mount(source:Option<&str>,target:&Path,kind:Option<&str>,flags:libc::c_ulong,data:Option<&str>)->Result<()> {
    let source=source.map(CString::new).transpose().map_err(|_|"invalid_mount")?;
    let target=CString::new(target.as_os_str().as_encoded_bytes()).map_err(|_|"invalid_mount")?;
    let kind=kind.map(CString::new).transpose().map_err(|_|"invalid_mount")?;
    let data=data.map(CString::new).transpose().map_err(|_|"invalid_mount")?;
    if unsafe {libc::mount(source.as_ref().map_or(std::ptr::null(),|v|v.as_ptr()),target.as_ptr(),kind.as_ref().map_or(std::ptr::null(),|v|v.as_ptr()),flags,data.as_ref().map_or(std::ptr::null(),|v|v.as_ptr().cast()))}!=0 {
        return Err("mount_failed");
    }Ok(())
}
fn unmount(target:&Path)->Result<()> {
    let target=CString::new(target.as_os_str().as_encoded_bytes()).map_err(|_|"invalid_mount")?;
    if unsafe {libc::umount2(target.as_ptr(),0)}!=0 {
        let error=std::io::Error::last_os_error().raw_os_error();
        if error!=Some(libc::EINVAL) && error!=Some(libc::ENOENT) {return Err("unmount_failed");}
    }Ok(())
}
fn mkdir(path:&Path)->Result<()> {
    fs::create_dir_all(path).map_err(|_|"staging_directory_failed")?;
    secure::root_owned(path,true)?;Ok(())
}
fn destination(root:&Path,absolute:&Path)->Result<()> {
    let relative=absolute.strip_prefix("/").map_err(|_|"invalid_destination")?;
    let mut path=root.to_path_buf();
    for component in relative.components() {
        if !matches!(component,std::path::Component::Normal(_)) {return Err("invalid_destination");}
        path.push(component);
        match fs::create_dir(&path) {
            Ok(())=>fs::set_permissions(&path,fs::Permissions::from_mode(0o755)).map_err(|_|"destination_creation_failed")?,
            Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists=>(),Err(_)=>return Err("destination_creation_failed"),
        }
        // No existing image symlink may redirect construction outside this private overlay.
        secure::open(&path,true)?;
    }Ok(())
}
fn entrypoint(synthetic:bool)->Vec<&'static str> {
    vec!["/opt/scikeel/tools/bin/node",if synthetic {"/opt/scikeel/test/synthetic-runner.mjs"} else {"/opt/scikeel/tools/runner.mjs"}]
}
fn bind_environment(address:u8)->Result<String> {
    if !(2..=254).contains(&address) {return Err("invalid_network_address");}
    Ok(format!("SCIKEEL_BIND_ADDRESS=172.31.240.{address}"))
}
fn tenant_manifest(instance_id:&str,generation:u64,paths:&[PathBuf;6])->Value {
    json!({"schema":1,"instanceId":instance_id,"generation":generation,"workspaceDir":paths[0],"stateDir":paths[1],"home":paths[2],"scratchDir":paths[5]})
}
fn write_control(stage:&Path,name:&str,value:&Value)->Result<()> {
    let mut file=OpenOptions::new().write(true).create_new(true).mode(0o644).open(stage.join(name)).map_err(|_|"bundle_write_failed")?;
    file.write_all(&serde_json::to_vec(value).map_err(|_|"bundle_write_failed")?).and_then(|_|file.sync_all()).map_err(|_|"bundle_write_failed")?;
    file.set_permissions(fs::Permissions::from_mode(0o644)).map_err(|_|"bundle_write_failed")?;Ok(())
}
fn prepare(config:&Config,account:&Account)->Result<PathBuf> {
    let stage=stage(config,account);mkdir(&stage)?;
    for name in ["rootfs","upper","work","mounts"] {mkdir(&stage.join(name))?;}
    // Overlay root metadata comes from upperdir, whose launcher umask is 0077.
    // The tenant's / must be traversable; its host staging parents remain private.
    fs::set_permissions(stage.join("upper"),fs::Permissions::from_mode(0o755)).map_err(|_|"staging_directory_failed")?;
    let image=image(config,account.image_digest.as_deref().ok_or("invalid_image")?)?;
    let lower=secure::root_owned(&image,true)?;
    let options=format!("lowerdir=/proc/self/fd/{},upperdir={},workdir={}",lower.as_raw_fd(),stage.join("upper").display(),stage.join("work").display());
    // Small disk-backed launcher-only metadata layer; the immutable shared lower never changes.
    mount(Some("overlay"),&stage.join("rootfs"),Some("overlay"),libc::MS_NODEV|libc::MS_NOSUID,Some(&options))?;
    let sources=config.source_descriptors(account)?;
    quota::verify(&config.quota_device,account.project_id,config.quota_bytes,config.quota_inodes,&sources)?;
    let paths=config.sources(account);let mut mounts=Vec::new();
    write_control(&stage,"tenant.json",&tenant_manifest(&account.instance_id,account.generation,&paths))?;
    let mut entropy=[0u8;32];std::fs::File::open("/dev/urandom").and_then(|mut file|file.read_exact(&mut entropy)).map_err(|_|"secure_token_unavailable")?;
    let token=entropy.iter().map(|byte|format!("{byte:02x}")).collect::<String>();
    write_control(&stage,"runner-auth.json",&json!({"schema":1,"token":token}))?;
    destination(&stage.join("rootfs"),Path::new("/opt/scikeel"))?;
    for name in ["tenant.json","runner-auth.json"] {
        let file=stage.join("rootfs/opt/scikeel").join(name);
        OpenOptions::new().write(true).create_new(true).mode(0o644).open(&file).map_err(|_|"bundle_write_failed")?;
        mounts.push(json!({"source":stage.join(name),"destination":format!("/opt/scikeel/{name}"),"type":"bind","options":["bind","ro","nosuid","nodev","noexec"]}));
    }
    for (index,(source,path)) in sources.iter().zip(paths.iter()).enumerate() {
        let held=stage.join("mounts").join(index.to_string());mkdir(&held)?;
        mount(Some(&format!("/proc/self/fd/{}",source.as_raw_fd())),&held,None,libc::MS_BIND,None)?;
        mount(None,&held,None,libc::MS_REMOUNT|libc::MS_BIND|libc::MS_NOSUID|libc::MS_NODEV,None)?;
        destination(&stage.join("rootfs"),path)?;
        mounts.push(json!({"source":held,"destination":path,"type":"bind","options":["bind","rw","nosuid","nodev"]}));
    }
    for (path,kind,options) in [("/proc","proc",vec!["nosuid","nodev","noexec"]),("/dev","tmpfs",vec!["nosuid","mode=755","size=4m"]),
        ("/tmp","tmpfs",vec!["nosuid","nodev","mode=1777","size=64m"])] {
        destination(&stage.join("rootfs"),Path::new(path))?;
        mounts.push(json!({"source":kind,"destination":path,"type":kind,"options":options}));
    }
    let namespace=network_manifest(config,account)?;
    let args=entrypoint(config.synthetic);
    if config.synthetic {
        destination(&stage.join("rootfs"),Path::new("/opt/scikeel/test"))?;
        for name in ["synthetic-runner.mjs","probe-entry.mjs"] {
            let source=config.state_dir.join("synthetic").join(name);secure::root_owned(&source,false)?;
            let file=stage.join("rootfs/opt/scikeel/test").join(name);
            if !file.exists() {OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file).map_err(|_|"test_destination_failed")?;}
            mounts.push(json!({"source":source,"destination":format!("/opt/scikeel/test/{name}"),"type":"bind","options":["bind","ro","nosuid","nodev","noexec"]}));
        }
        destination(&stage.join("rootfs"),Path::new("/workspace"))?;
        mounts.push(json!({"source":stage.join("mounts/0"),"destination":"/workspace","type":"bind","options":["bind","rw","nosuid","nodev"]}));
    }
    let mut env=vec!["PATH=/opt/scikeel/science/bin:/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin".to_string(),
        format!("HOME={}",paths[2].display()),"LANG=C.UTF-8".into(),"UV_PYTHON_DOWNLOADS=never".into(),"UV_LINK_MODE=copy".into(),
        "PYTHONDONTWRITEBYTECODE=1".into(),"OMP_NUM_THREADS=1".into(),"OPENBLAS_NUM_THREADS=1".into(),"MKL_NUM_THREADS=1".into(),"NUMEXPR_NUM_THREADS=1".into()];
    env.extend(network::environment());
    env.push(bind_environment(account.address)?);
    let bundle=json!({"ociVersion":"1.0.2","hostname":"scikeel","root":{"path":"rootfs","readonly":true},
        "process":{"terminal":false,"user":{"uid":1000,"gid":1000},"args":args,"env":env,"cwd":paths[0],"noNewPrivileges":true,
        "capabilities":{"bounding":[],"effective":[],"inheritable":[],"permitted":[],"ambient":[]},
        "rlimits":[{"type":"RLIMIT_NOFILE","hard":1024,"soft":1024}]},"mounts":mounts,
        "linux":{"namespaces":[{"type":"pid"},{"type":"ipc"},{"type":"uts"},{"type":"mount"},{"type":"network","path":namespace}],
            "devices":[],"maskedPaths":["/proc/kcore","/proc/keys","/proc/timer_list","/sys/firmware"],"readonlyPaths":["/proc/sys","/proc/sysrq-trigger"]}});
    let mut file=OpenOptions::new().write(true).create_new(true).mode(0o600).open(stage.join("config.json")).map_err(|_|"bundle_write_failed")?;
    file.write_all(&serde_json::to_vec(&bundle).map_err(|_|"bundle_write_failed")?).and_then(|_|file.sync_all()).map_err(|_|"bundle_write_failed")?;
    mount(None,&stage.join("rootfs"),None,libc::MS_REMOUNT|libc::MS_RDONLY|libc::MS_NODEV|libc::MS_NOSUID,None)?;
    Ok(stage)
}
pub fn endpoints(config:&Config,account:&Account)->Result<Value> {
    let auth:Value=serde_json::from_slice(&secure::read_root_owned(&stage(config,account).join("runner-auth.json"),4096)?).map_err(|_|"invalid_runner_token")?;
    let token=auth["token"].as_str().filter(|token|token.len()==64 && token.bytes().all(|byte|byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).ok_or("invalid_runner_token")?;
    Ok(json!({"instanceId":account.instance_id,"generation":account.generation,"internalToken":token,
        "endpoint":format!("http://172.31.240.{}:4790",account.address),"runnerEndpoint":format!("http://172.31.240.{}:4791",account.address)}))
}
pub fn inspect(config:&Config,account:&Account)->Result<(Limits,QuotaEvidence)> {
    network::verify(config,account)?;
    quota::verify_backing_file(&config.quota_backing_file,&config.quota_device,config.quota_capacity)?;
    let limits=lifecycle::inspect_cgroup(&unit_cgroup(account)?)?;
    let quota=quota::verify(&config.quota_device,account.project_id,config.quota_bytes,config.quota_inodes,&config.source_descriptors(account)?)?;
    Ok((limits,quota))
}
fn health_request(port:u16,synthetic:bool,token:&str)->String {
    let path=if port==4790 && !synthetic {"/v1/health"} else {"/health"};
    format!("GET {path} HTTP/1.1\r\nHost: sandbox\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n")
}
fn health(address:u8,port:u16,synthetic:bool,token:&str)->bool {
    use std::net::{SocketAddr,TcpStream};
    let address:SocketAddr=match format!("172.31.240.{address}:{port}").parse() {Ok(a)=>a,Err(_)=>return false};
    let mut stream=match TcpStream::connect_timeout(&address,Duration::from_millis(250)) {Ok(s)=>s,Err(_)=>return false};
    let _=stream.set_read_timeout(Some(Duration::from_millis(250)));let _=stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream.write_all(health_request(port,synthetic,token).as_bytes()).is_err() {return false;}
    let mut bytes=[0;64];match stream.read(&mut bytes) {Ok(n)=>bytes[..n].starts_with(b"HTTP/1.1 200 "),Err(_)=>false}
}
pub fn start(config:&Config,account:&Account)->Result<()> {
    network::ensure(config,account)?;
    let bundle=prepare(config,account)?;
    let mut args=vec!["--quiet".into(),"--collect".into(),"--no-block".into(),"--service-type=exec".into(),
        format!("--unit={}",lifecycle::unit_name(&account.instance_id,account.generation)?)];
    for property in lifecycle::unit_properties() {args.push(format!("--property={property}"));}
    args.extend(["/usr/bin/nsenter".into(),format!("--mount=/proc/{}/ns/mnt",std::process::id()),"--".into(),config.runsc.display().to_string(),
        format!("--root={}",config.state_dir.join("runsc").display()),"--platform=systrap".into(),"--network=sandbox".into(),"--host-uds=none".into(),
        "--directfs=false".into(),"--ignore-cgroups".into(),"--file-access=exclusive".into(),"--file-access-mounts=exclusive".into(),
        "run".into(),"--bundle".into(),bundle.display().to_string(),container_id(account)]);
    command("/usr/bin/systemd-run",&args,5)?;
    let credentials=endpoints(config,account)?;
    let token=credentials["internalToken"].as_str().ok_or("invalid_runner_token")?;
    let deadline=Instant::now()+Duration::from_secs(20);
    while Instant::now()<deadline {
        if health(account.address,4790,config.synthetic,token) && health(account.address,4791,config.synthetic,token) {inspect(config,account)?;return Ok(());}
        std::thread::sleep(Duration::from_millis(100));
    }Err("sandbox_readiness_failed")
}
pub fn stop(config:&Config,account:&Account)->Result<()> {
    let unit=lifecycle::unit_name(&account.instance_id,account.generation)?;
    let cgroup=unit_cgroup(account)?;
    if cgroup.exists() {command("/usr/bin/systemctl",&["stop".into(),unit],8)?;}
    if cgroup.exists() {
        let events=fs::read_to_string(cgroup.join("cgroup.events")).map_err(|_|"cleanup_unverified")?;
        if !events.lines().any(|line|line=="populated 0") {return Err("cleanup_unverified");}
    }
    let runtime=config.state_dir.join("runsc");
    let prefix=container_id(account);
    let has_state=runtime.exists() && fs::read_dir(&runtime).map_err(|_|"runtime_state_unavailable")?.any(|entry|
        entry.ok().is_some_and(|entry|entry.file_name().to_str().is_some_and(|name|name==prefix || name.starts_with(&format!("{prefix}.")))));
    if has_state {command(config.runsc.to_str().ok_or("invalid_runsc_path")?,&[format!("--root={}",config.state_dir.join("runsc").display()),
        "delete".into(),"--force".into(),container_id(account)],5)?;}
    let stage=stage(config,account);
    if stage.exists() {
        secure::root_owned(&stage,true)?;
        for index in (0..6).rev() {unmount(&stage.join("mounts").join(index.to_string()))?;}
        unmount(&stage.join("rootfs"))?;
        fs::remove_dir_all(&stage).map_err(|_|"staging_cleanup_failed")?;
    }network::remove(config,account)?;Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn launcher_manifest_preserves_exact_owned_roots_without_parent_mounts() {
        let value=super::tenant_manifest("user-a",2,&[
            "/tenant/workspace".into(),"/tenant/state".into(),"/tenant/home".into(),"/tenant/claude".into(),"/tenant/codex".into(),"/tenant/scratch".into()]);
        assert_eq!(value["workspaceDir"],"/tenant/workspace");assert_eq!(value["home"],"/tenant/home");assert_eq!(value["generation"],2);
        assert_eq!(value.as_object().unwrap().len(),7);
    }
    #[test]
    fn mount_destinations_remain_traversable_under_the_root_launcher_umask() {
        use std::os::unix::fs::PermissionsExt;
        let root=std::env::temp_dir().join(format!("scikeel-destination-{}",std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let previous=unsafe {libc::umask(0o077)};
        let result=super::destination(&root,std::path::Path::new("/private/workspace"));
        unsafe {libc::umask(previous)};
        result.unwrap();
        let mode=std::fs::metadata(root.join("private")).unwrap().permissions().mode()&0o777;
        std::fs::remove_dir(root.join("private/workspace")).unwrap();
        std::fs::remove_dir(root.join("private")).unwrap();std::fs::remove_dir(root).unwrap();
        assert_eq!(mode,0o755);
    }
    #[test]
    fn managed_entrypoint_and_environment_use_only_fixed_addresses_and_tools() {
        assert_eq!(super::entrypoint(true),vec!["/opt/scikeel/tools/bin/node","/opt/scikeel/test/synthetic-runner.mjs"]);
        assert_eq!(super::entrypoint(false),vec!["/opt/scikeel/tools/bin/node","/opt/scikeel/tools/runner.mjs"]);
        assert_eq!(super::bind_environment(2).unwrap(),"SCIKEEL_BIND_ADDRESS=172.31.240.2");
        assert!(super::bind_environment(1).is_err());assert!(super::bind_environment(255).is_err());
        assert!(super::health_request(4790,false,"token").starts_with("GET /v1/health "));
        assert!(super::health_request(4790,true,"token").starts_with("GET /health "));
        assert!(super::health_request(4791,false,"token").contains("Authorization: Bearer token\r\n"));
    }
}
