use crate::protocol::Result;
use std::{ffi::CString,fs::File,io::Read,os::{fd::{AsRawFd,FromRawFd},unix::fs::MetadataExt},path::{Component,Path}};

#[repr(C)]
struct OpenHow {flags:u64,mode:u64,resolve:u64}
// Linux openat2: beneath + no magic links + no symlinks, with no fallback.
pub fn open(path:&Path,directory:bool)->Result<File> {
    if !path.is_absolute() || path.components().any(|c| !matches!(c,Component::RootDir|Component::Normal(_))) {
        return Err("invalid_configured_path");
    }
    let root=File::open("/").map_err(|_|"root_unavailable")?;
    let relative=CString::new(path.strip_prefix("/").map_err(|_|"invalid_configured_path")?.as_os_str().as_encoded_bytes())
        .map_err(|_|"invalid_configured_path")?;
    let how=OpenHow {flags:(libc::O_RDONLY|libc::O_CLOEXEC|libc::O_NONBLOCK|if directory {libc::O_DIRECTORY} else {0}) as u64,
        mode:0,resolve:0x08|0x02|0x04};
    let fd=unsafe {libc::syscall(libc::SYS_openat2,root.as_raw_fd(),relative.as_ptr(),&how,std::mem::size_of::<OpenHow>())};
    if fd<0 {return Err("secure_open_failed");}
    let file=unsafe {File::from_raw_fd(fd as i32)};
    let metadata=file.metadata().map_err(|_|"secure_stat_failed")?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {return Err("invalid_file_type");}
    Ok(file)
}
pub fn root_owned(path:&Path,directory:bool)->Result<File> {
    let file=open(path,directory)?;
    let m=file.metadata().map_err(|_|"secure_stat_failed")?;
    if m.uid()!=0 || m.mode()&0o022!=0 {return Err("untrusted_owner_or_mode");}
    // A root-owned leaf is insufficient when a writable parent can substitute it.
    let mut parent=path.parent();
    while let Some(p)=parent {
        if p==Path::new("/") {break;}
        let m=open(p,true)?.metadata().map_err(|_|"secure_stat_failed")?;
        if m.uid()!=0 || m.mode()&0o022!=0 {return Err("untrusted_parent");}
        parent=p.parent();
    }
    Ok(file)
}
pub fn read_root_owned(path:&Path,maximum:u64)->Result<Vec<u8>> {
    let file=root_owned(path,false)?;
    if file.metadata().map_err(|_|"secure_stat_failed")?.len()>maximum {return Err("file_too_large");}
    let mut bytes=Vec::new();file.take(maximum+1).read_to_end(&mut bytes).map_err(|_|"secure_read_failed")?;
    if bytes.len() as u64>maximum {return Err("file_too_large");}Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn symlinks_and_special_files_are_not_secure_roots() {
        assert!(open(Path::new("/proc/self/fd/0"),false).is_err());
        assert!(open(Path::new("/dev/null"),false).is_err());
        assert!(open(Path::new("/etc/../etc/passwd"),false).is_err());
        assert!(open(Path::new("relative"),true).is_err());
        assert!(open(Path::new("/etc"),true).is_ok());
    }
}
