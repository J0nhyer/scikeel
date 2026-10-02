use crate::protocol::Result;
use serde::Serialize;
use std::{ffi::CString, fs::File, os::fd::AsRawFd};

// Linux UAPI structures from linux/quota.h and linux/fs.h. No shell/setquota fallback.
#[repr(C)]
#[derive(Default)]
struct QuotaBlock { block_hard: u64, block_soft: u64, bytes: u64, inode_hard: u64,
    inode_soft: u64, inodes: u64, block_time: u64, inode_time: u64, valid: u32 }
#[repr(C)]
#[derive(Default)]
struct FsAttributes { flags:u32, extent_size:u32, extents:u32, project_id:u32, cow_extent_size:u32, padding:[u8;8] }
const Q_GETQUOTA: i32 = ((0x800007u32 << 8) | 2) as i32;
const Q_SETQUOTA: i32 = ((0x800008u32 << 8) | 2) as i32;
const FS_IOC_FSGETXATTR: libc::c_ulong = 0x801c581f;
const FS_IOC_FSSETXATTR: libc::c_ulong = 0x401c5820;
const FS_XFLAG_PROJINHERIT: u32 = 0x200;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct QuotaEvidence { pub project_id:u32, pub byte_limit:u64, pub inode_limit:u64,
    pub bytes:u64, pub inodes:u64, pub enforced:bool }
fn evidence(q:&QuotaBlock,project_id:u32,byte_limit:u64,inode_limit:u64)->Result<QuotaEvidence> {
    if byte_limit==0 || byte_limit%1024!=0 || inode_limit==0 || q.valid&5!=5
        || q.block_hard!=byte_limit/1024 || q.inode_hard!=inode_limit || q.bytes>byte_limit || q.inodes>inode_limit {
        return Err("quota_not_enforced");
    }
    Ok(QuotaEvidence {project_id,byte_limit,inode_limit,bytes:q.bytes,inodes:q.inodes,enforced:true})
}
pub fn verify(device:&str, project_id:u32,byte_limit:u64,inode_limit:u64,sources:&[File])->Result<QuotaEvidence> {
    if project_id<10_000 || sources.len()!=6 { return Err("invalid_quota_sources"); }
    let device=CString::new(device).map_err(|_|"invalid_quota_device")?;
    let mut quota=QuotaBlock::default();
    if unsafe {libc::quotactl(Q_GETQUOTA,device.as_ptr(),project_id as i32,(&mut quota as *mut QuotaBlock).cast())}!=0 {
        return Err("quota_unavailable");
    }
    for file in sources {
        let mut attributes=FsAttributes::default();
        if unsafe {libc::ioctl(file.as_raw_fd(),FS_IOC_FSGETXATTR,&mut attributes)}!=0
            || attributes.project_id!=project_id || attributes.flags&FS_XFLAG_PROJINHERIT==0 {
            return Err("quota_source_not_owned");
        }
        // The configured quota block device must govern every writable root.
        let device_metadata=std::fs::metadata(device.to_str().map_err(|_|"invalid_quota_device")?).map_err(|_|"invalid_quota_device")?;
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|_|"invalid_quota_source")?.dev()!=device_metadata.rdev() {
            return Err("quota_wrong_filesystem");
        }
    }
    evidence(&quota,project_id,byte_limit,inode_limit)
}
pub fn verify_backing_file(path:&std::path::Path,device:&str,capacity:u64)->Result<()> {
    use std::os::unix::fs::{FileTypeExt,MetadataExt};
    let file=crate::secure::root_owned(path,false)?;
    let metadata=file.metadata().map_err(|_|"quota_backing_unavailable")?;
    if metadata.len()!=capacity || metadata.blocks().checked_mul(512).is_none_or(|size|size<capacity) {
        return Err("quota_backing_not_reserved");
    }
    let device_metadata=std::fs::symlink_metadata(device).map_err(|_|"quota_device_unavailable")?;
    if !device_metadata.file_type().is_block_device() {return Err("invalid_quota_device");}
    let major=libc::major(device_metadata.rdev());let minor=libc::minor(device_metadata.rdev());
    let actual=std::fs::read_to_string(format!("/sys/dev/block/{major}:{minor}/loop/backing_file")).map_err(|_|"quota_backing_unavailable")?;
    if std::path::Path::new(actual.trim())!=path {return Err("quota_backing_wrong_device");}
    Ok(())
}
fn can_assign_project(current:u32,target:u32,empty:bool)->bool {
    current==target || (current==0 && empty)
}
fn directory(parent:&File,name:&str,project_id:u32,uid:u32,gid:u32)->Result<File> {
    use std::os::{fd::FromRawFd,unix::fs::MetadataExt};
    if !crate::protocol::identifier(name,64) {return Err("invalid_quota_directory");}
    let name=CString::new(name).map_err(|_|"invalid_quota_directory")?;
    let created=unsafe {libc::mkdirat(parent.as_raw_fd(),name.as_ptr(),0o700)}==0;
    if !created && std::io::Error::last_os_error().raw_os_error()!=Some(libc::EEXIST) {return Err("quota_directory_unavailable");}
    let fd=unsafe {libc::openat(parent.as_raw_fd(),name.as_ptr(),libc::O_RDONLY|libc::O_DIRECTORY|libc::O_CLOEXEC|libc::O_NOFOLLOW)};
    if fd<0 {return Err("quota_directory_unavailable");}
    let file=unsafe {File::from_raw_fd(fd)};
    let metadata=file.metadata().map_err(|_|"quota_directory_unavailable")?;
    if metadata.dev()!=parent.metadata().map_err(|_|"quota_directory_unavailable")?.dev() ||
        (!created && (metadata.uid()!=uid || metadata.gid()!=gid || metadata.mode()&0o022!=0)) {return Err("quota_directory_not_owned");}
    let mut attributes=FsAttributes::default();
    if unsafe {libc::ioctl(fd,FS_IOC_FSGETXATTR,&mut attributes)}!=0 {return Err("quota_unavailable");}
    let empty=std::fs::read_dir(format!("/proc/self/fd/{fd}")).map_err(|_|"quota_directory_unavailable")?.next().is_none();
    // Existing files require explicit migration, never a shallow retag of their parent.
    if !can_assign_project(attributes.project_id,project_id,empty) {return Err("quota_migration_required");}
    if attributes.project_id!=project_id || attributes.flags&FS_XFLAG_PROJINHERIT==0 {
        attributes.project_id=project_id;attributes.flags|=FS_XFLAG_PROJINHERIT;
        if unsafe {libc::ioctl(fd,FS_IOC_FSSETXATTR,&attributes)}!=0 {return Err("quota_assignment_failed");}
    }
    if created && (unsafe {libc::fchmod(fd,if uid==0 {0o755} else {0o700})}!=0 || unsafe {libc::fchown(fd,uid,gid)}!=0) {
        return Err("quota_directory_not_owned");
    }
    file.sync_all().map_err(|_|"quota_directory_unavailable")?;Ok(file)
}
pub fn provision(config:&crate::config::Config,account:&crate::registry::Account)->Result<QuotaEvidence> {
    use std::os::unix::fs::MetadataExt;
    if unsafe {libc::geteuid()}!=0 {return Err("root_required");}
    verify_backing_file(&config.quota_backing_file,&config.quota_device,config.quota_capacity)?;
    let instances=crate::secure::root_owned(&config.roots.instances,true)?;
    let native=crate::secure::root_owned(&config.roots.native,true)?;
    let device_metadata=std::fs::metadata(&config.quota_device).map_err(|_|"invalid_quota_device")?;
    if [instances.metadata(),native.metadata()].iter().any(|metadata|metadata.as_ref().map_or(true,|metadata|metadata.dev()!=device_metadata.rdev())) {
        return Err("quota_wrong_filesystem");
    }
    let device=CString::new(config.quota_device.as_str()).map_err(|_|"invalid_quota_device")?;
    let mut previous=QuotaBlock::default();
    if unsafe {libc::quotactl(Q_GETQUOTA,device.as_ptr(),account.project_id as i32,(&mut previous as *mut QuotaBlock).cast())}!=0 {
        return Err("quota_unavailable");
    }
    if previous.block_hard==0 && previous.inode_hard==0 && previous.bytes==0 && previous.inodes==0 {
        let mut quota=QuotaBlock {block_hard:config.quota_bytes/1024,inode_hard:config.quota_inodes,valid:5,..Default::default()};
        if unsafe {libc::quotactl(Q_SETQUOTA,device.as_ptr(),account.project_id as i32,(&mut quota as *mut QuotaBlock).cast())}!=0 {return Err("quota_assignment_failed");}
    } else {evidence(&previous,account.project_id,config.quota_bytes,config.quota_inodes)?;}
    let instance=directory(&instances,&account.instance_id,account.project_id,0,0)?;
    let home=directory(&native,&account.user_id,account.project_id,0,0)?;
    for (parent,names) in [(&instance,["workspace","state","scratch"]),(&home,["home","claude-config","codex-home"])] {
        for name in names {directory(parent,name,account.project_id,config.platform_uid,config.platform_gid)?;}
    }
    verify(&config.quota_device,account.project_id,config.quota_bytes,config.quota_inodes,&config.source_descriptors(account)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_requires_kernel_hard_byte_and_inode_limits_not_usage_scans() {
        let q=QuotaBlock {block_hard:2097152,inode_hard:100000,valid:5,..Default::default()};
        assert!(evidence(&q,10002,2*1024*1024*1024,100000).is_ok());
        for q in [QuotaBlock {block_hard:0,inode_hard:100000,valid:5,..Default::default()},
            QuotaBlock {block_hard:2097152,inode_hard:0,valid:5,..Default::default()},
            QuotaBlock {block_hard:2097152,inode_hard:100000,valid:0,..Default::default()},
            QuotaBlock {block_hard:2097152,inode_hard:100000,valid:5,bytes:3*1024*1024*1024,..Default::default()}] {
            assert!(evidence(&q,10002,2*1024*1024*1024,100000).is_err());
        }
    }
    #[test]
    fn quota_layout_matches_linux_uapi() {
        assert_eq!(std::mem::size_of::<FsAttributes>(),28);
        assert_eq!(std::mem::size_of::<QuotaBlock>(),72);
    }
    #[test]
    fn existing_trees_cannot_be_retagged_to_bypass_owned_storage_migration() {
        assert!(can_assign_project(0,10002,true));assert!(can_assign_project(10002,10002,false));
        assert!(!can_assign_project(0,10002,false));assert!(!can_assign_project(10003,10002,true));
        assert!(!can_assign_project(10003,10002,false));
    }
}
