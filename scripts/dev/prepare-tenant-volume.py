"""Reserve the fixed production tenant volume without changing platform routing."""
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path('/var/lib/scikeel')
IMAGE = ROOT / 'tenant-data.img'
MOUNT = ROOT / 'tenant-data'
MARKER = ROOT / 'tenant-quota.json'
HOST_CONFIG = pathlib.Path('/etc/scikeel/sandbox-host.json')
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


def verify_mount():
    mount = json.loads(command(['/usr/bin/findmnt', '--json', '--target', str(MOUNT)]))['filesystems'][0]
    device = mount['source']
    if (mount['target'] != str(MOUNT) or mount.get('fstype') != 'ext4'
            or not re.fullmatch(r'/dev/loop[0-9]+', device)):
        raise ValueError('production volume mount mismatch')
    backing = pathlib.Path('/sys/class/block') / pathlib.Path(device).name / 'loop/backing_file'
    if backing.read_text().strip() != str(IMAGE):
        raise ValueError('production volume backing mismatch')
    return device


def sync_host_config(value):
    # Synthetic launchers use a separate volume; initial provisioning may have no host config.
    try:
        metadata = HOST_CONFIG.lstat()
    except FileNotFoundError:
        return
    trusted(HOST_CONFIG, False)
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('invalid production host configuration file')
    descriptor = os.open(HOST_CONFIG, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r') as source:
        metadata = os.fstat(source.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or metadata.st_mode & 0o022 or metadata.st_size > 65536):
            raise ValueError('untrusted production host configuration')
        config = json.load(source)
    if not isinstance(config, dict):
        raise ValueError('invalid production host configuration')
    if config.get('synthetic') is True:
        return
    if (config.get('schema') != 1 or config.get('synthetic', False) is not False
            or config.get('quotaBackingFile') != str(IMAGE) or config.get('quotaCapacity') != CAPACITY
            or value.get('synthetic') is not False or value.get('image') != str(IMAGE)
            or value.get('capacity') != CAPACITY):
        raise ValueError('production host storage identity mismatch')
    roots = config.get('roots')
    if not isinstance(roots, dict):
        raise ValueError('production host storage roots mismatch')
    parents = []
    for name in ['instances', 'native']:
        expected = MOUNT / name
        raw = roots.get(name)
        if not isinstance(raw, str):
            raise ValueError('production host storage roots mismatch')
        path = pathlib.Path(raw)
        if (value.get(name) != str(expected) or not path.is_absolute() or str(path) != raw
                or '..' in path.parts or path.name != name or not path.parent.is_relative_to(MOUNT)
                or path.resolve(strict=True) != path or not path.is_dir()
                or path.stat().st_dev != MOUNT.stat().st_dev):
            raise ValueError('production host storage roots mismatch')
        trusted(path, True)
        parents.append(path.parent)
    if parents[0] != parents[1]:
        raise ValueError('production host storage roots mismatch')
    if config.get('quotaDevice') == value['device']:
        return
    config['quotaDevice'] = value['device']
    descriptor, temporary = tempfile.mkstemp(prefix='.sandbox-host-', dir=HOST_CONFIG.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            json.dump(config, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, HOST_CONFIG)
        directory = os.open(HOST_CONFIG.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('root and fixed production storage configuration required')
    trusted(ROOT, True)
    MOUNT.mkdir(mode=0o755, exist_ok=True)
    trusted(MOUNT, True)
    if MARKER.exists():
        trusted(MARKER, False)
        value = json.loads(MARKER.read_text())
        if (value.get('schema') != 1 or value.get('synthetic') is not False
                or value.get('capacity') != CAPACITY or value.get('image') != str(IMAGE)
                or any(value.get(name) != str(MOUNT / name) for name in ['instances', 'native'])):
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
        device = verify_mount()
        reserve_backing()
        value['device'] = device
        sync_host_config(value)
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
    device = verify_mount()
    reserve_backing()
    os.chmod(MOUNT, 0o755)
    for name in ['instances', 'native']:
        (MOUNT / name).mkdir(mode=0o755)
    value = {'schema': 1, 'synthetic': False, 'image': str(IMAGE), 'device': device, 'capacity': CAPACITY,
             'byteLimit': 1024**3, 'inodeLimit': 30000, 'instances': str(MOUNT / 'instances'),
             'native': str(MOUNT / 'native'), 'activated': False}
    sync_host_config(value)
    MARKER.write_text(json.dumps(value) + '\n')
    os.chmod(MARKER, 0o600)
    return value


if __name__ == '__main__':
    try:
        print(json.dumps(prepare()))
    except Exception as error:
        print('production storage preparation failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
