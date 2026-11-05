"""Reclaim stale native libraries and deduplicate immutable sandbox image files.

Run as root with --apply to change files. Daily maintenance should use
--temporary-only; image compaction is an explicit maintenance operation.
User data, image manifests, source files and reserved volumes are excluded.
"""
import argparse
import collections
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def live_paths():
    paths = set()
    mounted_images = set()
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            for line in (proc / 'maps').read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6:
                    paths.add(fields[5].removesuffix(' (deleted)'))
            try:
                mountinfo = (proc / 'mountinfo').read_text()
            except OSError as error:
                # Exiting tasks can lose their mount namespace before procfs disappears.
                if error.errno != errno.EINVAL:
                    raise
                mountinfo = ''
            mounted_images.update(re.findall(r'/var/lib/scikeel/images/([0-9a-f]{64})', mountinfo))
            for fd in (proc / 'fd').iterdir():
                try:
                    paths.add(os.readlink(fd).removesuffix(' (deleted)'))
                except FileNotFoundError:
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
    return paths, mounted_images


def temporary_libraries(apply):
    in_use, _ = live_paths()
    cutoff = time.time() - 86400
    removed = []
    pinned = 0
    for path in Path('/tmp').iterdir():
        if not re.fullmatch(r'\.[0-9a-f]{16}-[0-9a-f]{8}\.so', path.name):
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000:
            continue
        if info.st_mtime >= cutoff or str(path) in in_use:
            pinned += 1
            continue
        if apply:
            # Recheck process mappings before unlinking this particular file.
            current_paths, _ = live_paths()
            current = path.lstat()
            if str(path) in current_paths or (current.st_ino, current.st_mtime_ns, current.st_size) != (info.st_ino, info.st_mtime_ns, info.st_size):
                pinned += 1
                continue
            path.unlink()
        removed.append({'path': str(path), 'allocatedBytes': info.st_blocks * 512})
    return {'files': removed, 'pinnedCount': pinned}


def trusted_directory(path):
    for parent in (path, *path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted image directory: ' + str(parent))


def image_files(apply):
    store = Path('/var/lib/scikeel/images')
    trusted_directory(store)
    in_use, mounted = live_paths()
    groups = collections.defaultdict(lambda: collections.defaultdict(list))
    images = []
    for image in sorted(store.iterdir(), key=lambda p: (p.name not in mounted, p.name)):
        if not re.fullmatch('[0-9a-f]{64}', image.name):
            continue
        trusted_directory(image)
        root = image / 'rootfs'
        trusted_directory(root)
        manifest = json.loads((image / 'image-manifest.json').read_text())
        ready = json.loads((image / 'ready.json').read_text())
        expected = 'sha256:' + image.name
        if manifest['imageDigest'] != expected or ready['imageDigest'] != expected:
            raise ValueError('Image identity mismatch')
        images.append(image.name)
        for base, directories, files in os.walk(root, followlinks=False):
            trusted_directory(Path(base))
            for name in files:
                path = Path(base) / name
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_size < 1024 * 1024:
                    continue
                if info.st_uid != 0 or info.st_mode & 0o022:
                    continue
                attributes = tuple((key, os.getxattr(path, key, follow_symlinks=False))
                                   for key in sorted(os.listxattr(path, follow_symlinks=False)))
                key = (str(path.relative_to(root)), info.st_size, info.st_mode,
                       info.st_uid, info.st_gid, attributes)
                groups[key][(info.st_dev, info.st_ino)].append((path, info, image.name))
    links = []
    for inode_groups in groups.values():
        if len(inode_groups) < 2:
            continue
        by_hash = {}
        for aliases in inode_groups.values():
            path, info, image = aliases[0]
            sha = digest(path)
            canonical = by_hash.get(sha)
            if canonical is None:
                by_hash[sha] = path
                continue
            if image in mounted or any(str(p) in in_use for p, _, _ in aliases):
                continue
            for target, snapshot, _ in aliases:
                if apply:
                    current = target.lstat()
                    if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
                            snapshot.st_dev, snapshot.st_ino, snapshot.st_size, snapshot.st_mtime_ns):
                        raise ValueError('Image file changed during compaction')
                    if digest(canonical) != sha:
                        raise ValueError('Canonical image file changed')
                    temporary = target.with_name('.storage-link-' + uuid.uuid4().hex)
                    try:
                        os.link(canonical, temporary, follow_symlinks=False)
                        os.replace(temporary, target)
                    finally:
                        temporary.unlink(missing_ok=True)
                    if digest(target) != sha:
                        raise ValueError('Compacted file failed hash verification')
                links.append({'path': str(target), 'canonical': str(canonical), 'sha256': sha})
    return {'imagesPreserved': images, 'links': links}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--temporary-only', action='store_true')
    scope.add_argument('--images-only', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Root is required to inspect every process and trust image ownership')
    result = {'applied': args.apply}
    if not args.images_only:
        result['temporaryLibraries'] = temporary_libraries(args.apply)
    if not args.temporary_only:
        result['imageCompaction'] = image_files(args.apply)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
