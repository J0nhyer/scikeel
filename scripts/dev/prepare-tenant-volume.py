"""Reserve the fixed production tenant volume without changing platform routing."""
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys

ROOT = pathlib.Path('/var/lib/scikeel')
IMAGE = ROOT / 'tenant-data.img'
MOUNT = ROOT / 'tenant-data'
MARKER = ROOT / 'tenant-quota.json'
CAPACITY = 2 * 1024**3
RESERVE = 600 * 1024**2


def command(args):
    return subprocess.check_output(args, text=True, timeout=45, stderr=subprocess.DEVNULL,
                                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}).strip()


def trusted(path, directory):
    for item in [path, *path.parents]:
        metadata = item.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('untrusted production storage path')
    if directory and not path.is_dir():
        raise ValueError('invalid production storage directory')


def reserve_backing():
    descriptor = os.open(IMAGE, os.O_RDWR | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_size != CAPACITY:
            raise ValueError('untrusted production backing file')
        missing = max(0, CAPACITY - metadata.st_blocks * 512)
        if missing and shutil.disk_usage(ROOT).free < missing + RESERVE:
            raise ValueError('production reservation would consume host disk reserve')
        os.posix_fallocate(descriptor, 0, CAPACITY)
        os.fsync(descriptor)
        if os.fstat(descriptor).st_blocks * 512 < CAPACITY:
            raise ValueError('production storage reservation missing')
    finally:
        os.close(descriptor)


def prepare():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('root and fixed production storage configuration required')
    trusted(ROOT, True)
    MOUNT.mkdir(mode=0o755, exist_ok=True)
    trusted(MOUNT, True)
    if MARKER.exists():
        trusted(MARKER, False)
        value = json.loads(MARKER.read_text())
        if value.get('schema') != 1 or value.get('capacity') != CAPACITY or value.get('image') != str(IMAGE):
            raise ValueError('production storage marker mismatch')
        trusted(IMAGE, False)
        info = IMAGE.stat()
        if info.st_size != CAPACITY:
            raise ValueError('production storage reservation missing')
        reserve_backing()
        mount = json.loads(command(['/usr/bin/findmnt', '--json', '--target', str(MOUNT)]))['filesystems'][0]
        if mount['target'] != str(MOUNT):
            device = command(['/usr/sbin/losetup', '--find', '--show', '--nooverlap', str(IMAGE)])
            command(['/usr/bin/mount', '-o', 'prjquota,nodev,nosuid', device, str(MOUNT)])
        else:
            device = mount['source']
        backing = pathlib.Path('/sys/class/block') / pathlib.Path(device).name / 'loop/backing_file'
        if str(pathlib.Path(backing.read_text().strip()).resolve()) != str(IMAGE):
            raise ValueError('production volume backing mismatch')
        reserve_backing()
        value['device'] = device
        MARKER.write_text(json.dumps(value) + '\n')
        os.chmod(MARKER, 0o600)
        return value
    if IMAGE.exists() or any(MOUNT.iterdir()):
        raise ValueError('incomplete production storage requires explicit recovery')
    if shutil.disk_usage(ROOT).free < CAPACITY + RESERVE:
        raise ValueError('production volume would consume host disk reserve')
    descriptor = os.open(IMAGE, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(descriptor, 0, CAPACITY)
        os.fsync(descriptor)
        if os.fstat(descriptor).st_blocks * 512 < CAPACITY:
            raise ValueError('production backing storage is not reserved')
    finally:
        os.close(descriptor)
    command(['/usr/sbin/mkfs.ext4', '-q', '-F', '-O', 'project,quota', '-E', 'nodiscard,quotatype=prjquota,lazy_itable_init=0,lazy_journal_init=0',
             '-N', '100000', str(IMAGE)])
    if IMAGE.stat().st_blocks * 512 < CAPACITY:
        raise ValueError('mkfs removed production reservation')
    device = command(['/usr/sbin/losetup', '--find', '--show', '--nooverlap', str(IMAGE)])
    command(['/usr/bin/mount', '-o', 'prjquota,nodev,nosuid', device, str(MOUNT)])
    reserve_backing()
    os.chmod(MOUNT, 0o755)
    for name in ['instances', 'native']:
        (MOUNT / name).mkdir(mode=0o755)
    value = {'schema': 1, 'synthetic': False, 'image': str(IMAGE), 'device': device, 'capacity': CAPACITY,
             'byteLimit': 1024**3, 'inodeLimit': 30000, 'instances': str(MOUNT / 'instances'),
             'native': str(MOUNT / 'native'), 'activated': False}
    MARKER.write_text(json.dumps(value) + '\n')
    os.chmod(MARKER, 0o600)
    return value


if __name__ == '__main__':
    try:
        print(json.dumps(prepare()))
    except Exception as error:
        print('production storage preparation failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
