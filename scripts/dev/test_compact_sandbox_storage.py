import errno
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'compact_sandbox_storage', Path(__file__).with_name('compact-sandbox-storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class LivePathsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.image = 'a' * 64
        for pid in ['123', '456']:
            proc = self.root / pid
            proc.mkdir()
            (proc / 'maps').write_text(
                '1000-2000 r-xp 00000000 00:00 1 /tmp/mapped-' + pid + '.so\n')
            (proc / 'mountinfo').write_text(
                '1 2 0:1 / /var/lib/scikeel/images/' + self.image + '/rootfs rw\n')
            (proc / 'fd').mkdir()
            (proc / 'fd/7').symlink_to('/tmp/open-' + pid + '.so')

    def read_paths(self, mount_error=None):
        original = Path.read_text

        def read(path, *args, **kwargs):
            if mount_error and path == self.root / '123/mountinfo':
                raise OSError(mount_error, 'simulated procfs failure')
            return original(path, *args, **kwargs)

        with patch.object(storage, 'Path', return_value=self.root), \
                patch.object(Path, 'read_text', read):
            return storage.live_paths()

    def test_collects_mappings_open_files_and_mounted_images(self):
        paths, images = self.read_paths()
        self.assertEqual(paths, {'/tmp/mapped-123.so', '/tmp/mapped-456.so',
                                 '/tmp/open-123.so', '/tmp/open-456.so'})
        self.assertEqual(images, {self.image})

    def test_invalid_mountinfo_keeps_scanning_open_files_and_other_processes(self):
        paths, images = self.read_paths(errno.EINVAL)
        self.assertIn('/tmp/open-123.so', paths)
        self.assertIn('/tmp/mapped-123.so', paths)
        self.assertIn('/tmp/open-456.so', paths)
        self.assertEqual(images, {self.image})

    def test_permission_failure_stops_cleanup(self):
        with self.assertRaises(PermissionError):
            self.read_paths(errno.EACCES)

    def test_unexpected_io_failure_stops_cleanup(self):
        with self.assertRaises(OSError) as error:
            self.read_paths(errno.EIO)
        self.assertEqual(error.exception.errno, errno.EIO)


if __name__ == '__main__':
    unittest.main()
