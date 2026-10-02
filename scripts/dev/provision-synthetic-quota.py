"""Provision a reserved, synthetic-only project-quota filesystem for acceptance."""
import ctypes
import errno
import fcntl
import json
import os
import pathlib
import shutil
import stat
import struct
import subprocess
import sys

ROOT = pathlib.Path('/var/lib/scikeel')
IMAGE = ROOT / 'fixture-data.img'
MOUNT = ROOT / 'fixture-data'
CAPACITY = 256 * 1024**2
BYTES = 64 * 1024**2
INODES = 1024

class Quota(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ['block_hard', 'block_soft', 'bytes', 'inode_hard',
                'inode_soft', 'inodes', 'block_time', 'inode_time']] + [('valid', ctypes.c_uint32)]

LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.quotactl.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
LIBC.quotactl.restype = ctypes.c_int

def quota(device, project, block):
    command = ctypes.c_int((0x800008 << 8) | 2)
    if LIBC.quotactl(command, device.encode(), project, ctypes.byref(block)) != 0:
        raise OSError(ctypes.get_errno(), 'kernel project quota failed')

def project(path, identifier):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        attributes = bytearray(28)
        fcntl.ioctl(descriptor, 0x801c581f, attributes, True)
        fields = list(struct.unpack('IIIII8s', attributes))
        fields[0] |= 0x200
        fields[3] = identifier
        fcntl.ioctl(descriptor, 0x401c5820, struct.pack('IIIII8s', *fields))
    finally:
        os.close(descriptor)

def command(args):
    return subprocess.check_output(args, text=True, timeout=30, stderr=subprocess.DEVNULL,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'}).strip()

def provision():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('root and fixed synthetic configuration required')
    ROOT.mkdir(mode=0o755, exist_ok=True)
    for path in [ROOT, *ROOT.parents]:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('untrusted fixture parent')
    MOUNT.mkdir(mode=0o755, exist_ok=True)
    marker = ROOT / 'fixture-quota.json'
    if marker.exists():
        value = json.loads(marker.read_text())
        mounted = command(['/usr/bin/findmnt','-no','SOURCE','--target',str(MOUNT)])
        if value.get('schema') != 1 or value.get('capacity') != CAPACITY or mounted != value.get('device'):
            raise ValueError('existing fixture volume is not mounted')
        # mkfs/discard must not leave a sparse backing file behind.
        descriptor=os.open(IMAGE,os.O_RDWR|os.O_NOFOLLOW)
        try:
            info=os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_size!=CAPACITY:
                raise ValueError('untrusted fixture backing file')
            if info.st_blocks*512<CAPACITY:
                if shutil.disk_usage(ROOT).free<CAPACITY+600*1024**2:
                    raise ValueError('cannot restore the reserved fixture backing budget')
                os.posix_fallocate(descriptor,0,CAPACITY);os.fsync(descriptor)
            if os.fstat(descriptor).st_blocks*512<CAPACITY:
                raise ValueError('fixture backing storage is not reserved')
        finally:
            os.close(descriptor)
        return value
    if IMAGE.exists():
        raise ValueError('incomplete fixture allocation requires explicit recovery')
    if shutil.disk_usage(ROOT).free < CAPACITY + 600 * 1024**2:
        raise ValueError('fixture volume would consume host disk reserve')
    descriptor = os.open(IMAGE, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(descriptor, 0, CAPACITY)
        os.fsync(descriptor)
        if os.fstat(descriptor).st_blocks * 512 < CAPACITY:
            raise ValueError('fixture backing storage is not reserved')
    finally:
        os.close(descriptor)
    command(['/usr/sbin/mkfs.ext4','-q','-F','-O','project,quota','-E','nodiscard,quotatype=prjquota','-N','10000',str(IMAGE)])
    if IMAGE.stat().st_blocks*512<CAPACITY:
        raise ValueError('mkfs removed the fixture backing reservation')
    device = command(['/usr/sbin/losetup','--find','--show','--nooverlap',str(IMAGE)])
    if not device.startswith('/dev/loop') or not device[len('/dev/loop'):].isdigit():
        raise ValueError('unexpected fixture device')
    command(['/usr/bin/mount','-o','prjquota,nodev,nosuid',device,str(MOUNT)])
    os.chmod(MOUNT,0o755)
    for name in ['instances','native']:
        (MOUNT/name).mkdir(mode=0o755)
    for suffix, address in [('a',2),('b',3)]:
        project_id = 10000 + address
        instance = MOUNT/'instances'/('sandbox-test-'+suffix)
        native = MOUNT/'native'/('sandbox-test-'+suffix)
        for account in [instance,native]:
            account.mkdir(mode=0o755)
            project(account,project_id)
        for parent,names in [(instance,['workspace','state','scratch']),(native,['home','claude-config','codex-home'])]:
            for name in names:
                path=parent/name;path.mkdir(mode=0o700);os.chown(path,1000,1000)
                project(path,project_id)
        limit=Quota(block_hard=BYTES//1024,block_soft=BYTES//1024,inode_hard=INODES,inode_soft=INODES,valid=5)
        quota(device,project_id,limit)
    value={'schema':1,'synthetic':True,'device':device,'capacity':CAPACITY,'byteLimit':BYTES,'inodeLimit':INODES,
        'instances':str(MOUNT/'instances'),'native':str(MOUNT/'native')}
    marker.write_text(json.dumps(value)+'\n');os.chmod(marker,0o600)
    return value

if __name__=='__main__':
    try:
        print(json.dumps(provision()))
    except Exception as error:
        print('synthetic quota provisioning failed: '+(str(error) if isinstance(error,ValueError) else type(error).__name__),file=sys.stderr)
        sys.exit(1)
