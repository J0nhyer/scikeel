use crate::{config::Config,protocol::{self,Operation,Response,Result},registry::{Registry,Status},secure};
use serde_json::{json,Value};
use std::{fs::{self,File,OpenOptions},io::{BufRead,BufReader,Read,Write},os::{fd::AsRawFd,unix::{fs::{FileTypeExt,MetadataExt,OpenOptionsExt,PermissionsExt},net::{UnixListener,UnixStream}}},path::Path,time::Duration};

pub fn peer_uid(stream:&UnixStream)->Result<u32> {
    let mut credentials:libc::ucred=unsafe {std::mem::zeroed()};
    let mut length=std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {libc::getsockopt(stream.as_raw_fd(),libc::SOL_SOCKET,libc::SO_PEERCRED,
        (&mut credentials as *mut libc::ucred).cast(),&mut length)}!=0 || length as usize!=std::mem::size_of::<libc::ucred>() {
        return Err("peer_credentials_unavailable");
    }Ok(credentials.uid)
}
struct Host {config:Config,registry:Registry}
impl Host {
    fn load(config:Config)->Result<Self> {
        let path=config.state_dir.join("registry.json");
        let registry=if fs::symlink_metadata(&path).is_ok() {
            serde_json::from_slice(&secure::read_root_owned(&path,1024*1024)?).map_err(|_|"invalid_registry")?
        } else {Registry::default()};
        let host=Self {config,registry};host.registry.validate()?;Ok(host)
    }
    fn save(&self)->Result<()> {
        self.registry.validate()?;
        let temporary=self.config.state_dir.join(format!("registry-{}.tmp",std::process::id()));
        let bytes=serde_json::to_vec(&self.registry).map_err(|_|"registry_write_failed")?;
        let mut file=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_|"registry_write_failed")?;
        let written=(|| {file.write_all(&bytes).map_err(|_|"registry_write_failed")?;
            file.sync_all().map_err(|_|"registry_write_failed")?;
            fs::rename(&temporary,self.config.state_dir.join("registry.json")).map_err(|_|"registry_write_failed")?;
            File::open(&self.config.state_dir).and_then(|file|file.sync_all()).map_err(|_|"registry_write_failed")})();
        if written.is_err() {let _=fs::remove_file(&temporary);}written
    }
    fn operation(&mut self,operation:Operation)->Result<Value> {
        if self.config.synthetic && !operation.instance_id().starts_with("sandbox-test-") {
            return Err("synthetic_identity_required");
        }
        if self.config.synthetic && matches!(&operation, Operation::Register { user_id, .. } if !user_id.starts_with("sandbox-test-")) {
            return Err("synthetic_identity_required");
        }
        match operation {
            Operation::Register {instance_id,user_id}=>{
                let account=self.registry.register(&instance_id,&user_id)?;self.save()?;
                Ok(json!({"instanceId":account.instance_id,"generation":account.generation}))
            }
            Operation::Inspect {instance_id}=>{
                let account=self.registry.account(&instance_id)?.clone();
                let mut result=json!({"instanceId":account.instance_id,"generation":account.generation,"status":account.status});
                if account.status==Status::Ready {
                    let (limits,quota)=crate::backend::inspect(&self.config,&account)?;
                    result["limits"]=serde_json::to_value(limits).map_err(|_|"invalid_evidence")?;
                    result["quota"]=serde_json::to_value(quota).map_err(|_|"invalid_evidence")?;
                    result["imageDigest"]=json!(account.image_digest);
                    result["endpoint"]=json!(format!("http://172.31.240.{}:4790",account.address));
                    result["runnerEndpoint"]=json!(format!("http://172.31.240.{}:4791",account.address));
                    result["internalToken"]=crate::backend::endpoints(&self.config,&account)?["internalToken"].clone();
                }
                Ok(result)
            }
            Operation::Start {instance_id,generation,image_digest}=>{
                let current=self.registry.account(&instance_id)?.clone();
                if current.status==Status::Ready && current.generation==generation && current.image_digest.as_deref()==Some(&image_digest) {
                    crate::backend::inspect(&self.config,&current)?;
                    return crate::backend::endpoints(&self.config,&current);
                }
                // Reject missing prerequisites before changing persistent generation/state.
                crate::backend::preflight(&self.config,&current,&image_digest)?;
                let account=self.registry.begin_start(&instance_id,generation,&image_digest)?;self.save()?;
                let result=crate::backend::start(&self.config,&account);
                match result {
                    Ok(())=>{self.registry.mark_ready(&instance_id,generation)?;self.save()?;crate::backend::endpoints(&self.config,&account)}
                    Err(error)=>{
                        // Do not report an ordinary failure unless cleanup actually stopped descendants.
                        crate::backend::stop(&self.config,&account)?;
                        self.registry.mark_stopped(&instance_id,generation,true)?;self.save()?;Err(error)
                    }
                }
            }
            Operation::Stop {instance_id,generation,..}=>{
                let account=self.registry.account(&instance_id)?.clone();
                if account.last_stopped_generation!=Some(generation) {
                    if account.generation!=generation {return Err("stale_generation");}
                    crate::backend::stop(&self.config,&account)?;
                    self.registry.mark_stopped(&instance_id,generation,false)?;self.save()?;
                }
                Ok(json!({"instanceId":instance_id,"generation":generation,"stopped":true}))
            }
        }
    }
    fn reconcile(&mut self)->Result<()> {
        let interrupted:Vec<_>=self.registry.accounts.values().filter(|a| matches!(a.status,Status::Starting|Status::Ready)).cloned().collect();
        for account in interrupted {
            crate::backend::stop(&self.config,&account)?;
            self.registry.mark_stopped(&account.instance_id,account.generation,true)?;
            self.save()?;
        }Ok(())
    }
}
fn socket(config:&Config)->Result<UnixListener> {
    let parent=config.socket_path.parent().ok_or("invalid_socket_path")?;
    secure::root_owned(parent,true)?;
    if let Ok(metadata)=fs::symlink_metadata(&config.socket_path) {
        if !metadata.file_type().is_socket() || metadata.uid()!=0 {return Err("untrusted_existing_socket");}
        // A live listener must never be stolen by a second daemon.
        if UnixStream::connect(&config.socket_path).is_ok() {return Err("launcher_already_running");}
        fs::remove_file(&config.socket_path).map_err(|_|"socket_cleanup_failed")?;
    }
    let listener=UnixListener::bind(&config.socket_path).map_err(|_|"socket_bind_failed")?;
    fs::set_permissions(&config.socket_path,fs::Permissions::from_mode(0o660)).map_err(|_|"socket_permissions_failed")?;
    let file_name=std::ffi::CString::new(config.socket_path.as_os_str().as_encoded_bytes()).map_err(|_|"invalid_socket_path")?;
    if unsafe {libc::chown(file_name.as_ptr(),0,config.platform_gid)}!=0 {return Err("socket_permissions_failed");}
    Ok(listener)
}
fn notify_ready()->Result<()> {
    let Some(address)=std::env::var_os("NOTIFY_SOCKET") else {return Ok(());};
    let bytes=address.as_encoded_bytes();
    use std::os::linux::net::SocketAddrExt;
    let address=if bytes.first()==Some(&b'@') {
        std::os::unix::net::SocketAddr::from_abstract_name(&bytes[1..]).map_err(|_|"invalid_notify_socket")?
    } else {
        std::os::unix::net::SocketAddr::from_pathname(Path::new(&address)).map_err(|_|"invalid_notify_socket")?
    };
    std::os::unix::net::UnixDatagram::unbound().and_then(|socket|socket.send_to_addr(b"READY=1",&address))
        .map_err(|_|"notify_failed")?;
    Ok(())
}
pub fn run()->Result<()> {
    if unsafe {libc::geteuid()}!=0 {return Err("root_required");}
    let args:Vec<_>=std::env::args().skip(1).collect();
    if args.len()!=2 || args[0]!="--config" || args[1]!="/etc/scikeel/sandbox-host.json" {return Err("fixed_configuration_required");}
    let config=Config::load(Path::new(&args[1]))?;
    let mut host=Host::load(config)?;
    // Bind first to exclude a second launcher, then reconcile interrupted generations.
    let listener=socket(&host.config)?;host.reconcile()?;notify_ready()?;
    for connection in listener.incoming() {
        let mut stream=connection.map_err(|_|"socket_accept_failed")?;
        let uid=match peer_uid(&stream) {Ok(uid) if uid==host.config.platform_uid=>uid,_=>continue};
        stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|_|"socket_timeout_failed")?;
        stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|_|"socket_timeout_failed")?;
        let mut bytes=Vec::new();
        let read=BufReader::new((&mut stream).take((protocol::MAX_FRAME+1) as u64)).read_until(b'\n',&mut bytes);
        if read.is_err() {continue;}
        let request=match protocol::parse(&bytes,uid,host.config.platform_uid) {Ok(request)=>request,Err(_)=>continue};
        let response=Response::new(request.request_id,host.operation(request.operation));
        let encoded=serde_json::to_vec(&response).map_err(|_|"invalid_response")?;
        if encoded.len()>protocol::MAX_FRAME-1 {return Err("response_too_large");}
        let _=stream.write_all(&encoded);let _=stream.write_all(b"\n");
    }Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unix_socket_peer_identity_is_kernel_reported() {
        let (a,_)=UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(),unsafe {libc::getuid()});
    }
}
