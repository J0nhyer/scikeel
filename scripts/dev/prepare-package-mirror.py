"""Provision the fixed, reserved public mirror store and install locked wheels offline."""
import ctypes
import fcntl
import json
import os
import pathlib
import pwd
import secrets
import shutil
import stat
import subprocess
import sys

ROOT = pathlib.Path('/var/lib/scikeel')
IMAGE = ROOT / 'package-mirror.img'
STORE = ROOT / 'package-mirror'
RECEIPT = ROOT / 'package-mirror-quota.json'
CAPACITY = 2 * 1024**3
PROJECT = 90001
TOOLS = pathlib.Path('/usr/lib/scikeel/mirror')
SOURCE = pathlib.Path('/opt/open-science-desktop/.worktrees/tenant-science-isolation')
UV = '/opt/open-science-desktop/.deploy/osd/releases/0.5.2/uv'

class Quota(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ['block_hard', 'block_soft', 'bytes', 'inode_hard', 'inode_soft', 'inodes', 'block_time', 'inode_time']] + [('valid', ctypes.c_uint32)]

def run(argv, limit=30, user=None):
    command = ['/usr/sbin/runuser', '-u', user, '--', *argv] if user else argv
    result = subprocess.run(command, capture_output=True, timeout=limit, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(STORE), 'LANG': 'C.UTF-8'})
    if result.returncode:
        raise ValueError('mirror setup command failed')
    return result.stdout.decode().strip()

def trusted(path, directory=False):
    metadata = path.lstat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o022 or (not stat.S_ISDIR(metadata.st_mode) if directory else not stat.S_ISREG(metadata.st_mode)):
        raise ValueError('untrusted mirror setup input')

def provision():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError('fixed root-owned setup required')
    trusted(pathlib.Path(__file__))
    try:
        account = pwd.getpwnam('scikeel-mirror')
    except KeyError:
        run(['/usr/sbin/useradd', '--system', '--home-dir', str(STORE), '--no-create-home', '--shell', '/usr/sbin/nologin', 'scikeel-mirror'])
        account = pwd.getpwnam('scikeel-mirror')
    if account.pw_uid == 0 or account.pw_uid == 1000:
        raise ValueError('mirror requires a dedicated service identity')
    STORE.mkdir(mode=0o755, exist_ok=True)
    if RECEIPT.exists():
        trusted(RECEIPT)
        receipt = json.loads(RECEIPT.read_text())
        if receipt['capacity'] != CAPACITY or receipt['projectId'] != PROJECT:
            raise ValueError('unexpected public store identity')
    else:
        if IMAGE.exists() or any(STORE.iterdir()):
            raise ValueError('incomplete public store needs explicit recovery')
        if shutil.disk_usage(ROOT).free < CAPACITY + 600 * 1024**2:
            raise ValueError('mirror allocation exceeds disk reserve')
        descriptor = os.open(IMAGE, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.posix_fallocate(descriptor, 0, CAPACITY)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        run(['/usr/sbin/mkfs.ext4', '-q', '-F', '-O', 'project,quota', '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0,quotatype=prjquota', '-N', '100000', str(IMAGE)])
        device = run(['/usr/sbin/losetup', '--find', '--show', '--nooverlap', str(IMAGE)])
        if not device.startswith('/dev/loop') or not device[9:].isdigit():
            raise ValueError('unexpected public cache device')
        run(['/usr/bin/mount', '-o', 'prjquota,nodev,nosuid', device, str(STORE)])
        descriptor = os.open(STORE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            attributes = bytearray(28)
            fcntl.ioctl(descriptor, 0x801c581f, attributes, True)
            import struct
            fields = list(struct.unpack('IIIII8s', attributes))
            fields[0] |= 0x200
            fields[3] = PROJECT
            fcntl.ioctl(descriptor, 0x401c5820, struct.pack('IIIII8s', *fields))
            os.fchmod(descriptor, 0o700)
            os.fchown(descriptor, account.pw_uid, account.pw_gid)
        finally:
            os.close(descriptor)
        quota = Quota(block_hard=CAPACITY // 1024, inode_hard=90000, valid=5)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.quotactl(ctypes.c_int((0x800008 << 8) | 2), device.encode(), PROJECT, ctypes.byref(quota)) != 0:
            raise ValueError('public cache quota unavailable')
        RECEIPT.write_text(json.dumps({'schema': 1, 'capacity': CAPACITY, 'projectId': PROJECT, 'byteLimit': CAPACITY, 'inodeLimit': 90000, 'device': device}) + '\n')
        os.chmod(RECEIPT, 0o600)
    metadata = IMAGE.lstat()
    if metadata.st_uid != 0 or not stat.S_ISREG(metadata.st_mode) or metadata.st_size != CAPACITY:
        raise ValueError('public cache storage not reserved')
    if metadata.st_blocks * 512 < CAPACITY:
        missing = CAPACITY - metadata.st_blocks * 512
        if shutil.disk_usage(ROOT).free < missing + 600 * 1024**2:
            raise ValueError('public cache storage not reserved')
        descriptor = os.open(IMAGE, os.O_RDWR | os.O_NOFOLLOW)
        try:
            # Allocate any mkfs-created holes without changing existing filesystem bytes.
            os.posix_fallocate(descriptor, 0, CAPACITY)
            os.fsync(descriptor)
            if os.fstat(descriptor).st_blocks * 512 < CAPACITY:
                raise ValueError('public cache storage not reserved')
        finally:
            os.close(descriptor)
    if not os.path.ismount(STORE):
        raise ValueError('public cache volume unavailable')
    receipt = json.loads(RECEIPT.read_text())
    device = receipt['device']
    mounted = run(['/usr/bin/findmnt', '-n', '-o', 'SOURCE', '--target', str(STORE)])
    if mounted != device or not device.startswith('/dev/loop') or not device[9:].isdigit():
        raise ValueError('public cache device mismatch')
    backing = pathlib.Path('/sys/class/block') / pathlib.Path(device).name / 'loop/backing_file'
    if pathlib.Path(backing.read_text().strip()) != IMAGE:
        raise ValueError('public cache backing mismatch')
    actual = Quota()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.quotactl(ctypes.c_int((0x800007 << 8) | 2), device.encode(), PROJECT, ctypes.byref(actual)) != 0 or actual.block_hard != CAPACITY // 1024 or actual.inode_hard != 90000:
        raise ValueError('public cache quota not enforced')
    TOOLS.parent.mkdir(parents=True, exist_ok=True)
    if not (TOOLS / 'bin/python').exists():
        run([UV, 'venv', '--python', '/usr/bin/python3', str(TOOLS)])
    run([UV, 'pip', 'sync', '--require-hashes', '--only-binary', ':all:', '--no-index', '--find-links', str(SOURCE / '.deploy/mirror-wheels/wheels'),
         '--python', str(TOOLS / 'bin/python'), str(SOURCE / 'runtime/sandbox/image/package-mirror.lock')])
    data = STORE / 'data'
    data.mkdir(mode=0o700, exist_ok=True)
    os.chown(data, account.pw_uid, account.pw_gid)
    if not (data / '.nodeinfo').exists():
        # The generated hash disables trivial root login without putting a password in argv/logs.
        password = secrets.token_hex(48)
        result = subprocess.run([str(TOOLS / 'bin/python'), '-c', 'import sys;from passlib.hash import argon2;print(argon2.hash(sys.stdin.read()))'],
                                input=password, text=True, capture_output=True, timeout=15)
        if result.returncode:
            raise ValueError('mirror root identity initialization failed')
        run([str(TOOLS / 'bin/devpi-init'), '--serverdir', str(data), '--root-passwd-hash', result.stdout.strip()], user='scikeel-mirror')
    # Cold configuration avoids fetching the multi-million-entry PyPI root index.
    # A named package is looked up on demand and remains cached for all tenants.
    run(['/usr/bin/systemctl', 'stop', 'scikeel-package-mirror.service'])
    configure = """from devpi_server.config import get_pluginmanager, parseoptions
from devpi_server.main import xom_from_config
config = parseoptions(get_pluginmanager(), ['devpi-server', '--serverdir', '/var/lib/scikeel/package-mirror/data'])
xom = xom_from_config(config)
with xom.keyfs.write_transaction():
    stage = xom.model.getstage('root/pypi')
    stage.modify(mirror_no_project_list=True)
"""
    run([str(TOOLS / 'bin/python'), '-c', configure], user='scikeel-mirror')
    secret = data / '.secret'
    if not secret.exists():
        descriptor = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(descriptor, secrets.token_bytes(64))
            os.fsync(descriptor)
            os.fchown(descriptor, account.pw_uid, account.pw_gid)
        finally:
            os.close(descriptor)
    print(json.dumps({'publicMirrorInstalled': True, 'privateIdentity': account.pw_uid, 'byteLimit': CAPACITY, 'inodeLimit': 90000, 'reserved': True}))

if __name__ == '__main__':
    try:
        provision()
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else 'mirror setup failed', file=sys.stderr)
        sys.exit(1)
