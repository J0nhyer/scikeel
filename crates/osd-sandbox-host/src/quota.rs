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
const FS_IOC_FSGETXATTR: libc::c_ulong = 0x801c581f;
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
}
