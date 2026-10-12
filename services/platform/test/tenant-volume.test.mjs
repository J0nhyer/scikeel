import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/dev/prepare-tenant-volume.py", import.meta.url));
// No mount, loop-device allocation, production paths or third-party Python dependencies.
const fixture = String.raw`
import copy, json, os, pathlib, stat, sys, tempfile, unittest
from unittest.mock import patch
namespace = {'__name__': 'tenant_volume_fixture'}
exec(compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], 'exec'), namespace)

class TenantVolumeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.mount = self.root / 'tenant-data'
        for name in ['instances', 'native']:
            (self.mount / name).mkdir(parents=True)
            (self.mount / name).chmod(0o755)
        self.mount.chmod(0o755)
        self.config_path = self.root / 'sandbox-host.json'
        self.marker = {'schema': 1, 'synthetic': False, 'image': str(self.root / 'tenant-data.img'),
                       'capacity': namespace['CAPACITY'], 'device': '/dev/loop6',
                       'instances': str(self.mount / 'instances'), 'native': str(self.mount / 'native')}
        self.config = {'schema': 1, 'synthetic': False, 'quotaDevice': '/dev/loop11',
                       'quotaBackingFile': self.marker['image'], 'quotaCapacity': self.marker['capacity'],
                       'roots': {'instances': self.marker['instances'], 'native': self.marker['native'],
                                 'images': '/var/lib/scikeel/images'}, 'untouched': {'secret': 'fixture-only'}}
        for key, value in {'ROOT': self.root, 'IMAGE': self.root / 'tenant-data.img',
                           'MOUNT': self.mount, 'HOST_CONFIG': self.config_path}.items():
            replacement = patch.dict(namespace, {key: value})
            replacement.start()
            self.addCleanup(replacement.stop)
        # A tempfile lives beneath /tmp; production still requires trusted ancestors.
        original = namespace['trusted']
        real_parents = pathlib.Path.parents
        def trusted_fixture(path, directory):
            with patch.object(pathlib.Path, 'parents', property(lambda item:
                    tuple(parent for parent in real_parents.__get__(item) if parent.is_relative_to(self.root)))):
                metadata = path.lstat()
                if metadata.st_uid != os.getuid():
                    raise ValueError('untrusted fixture owner')
                # Map the fixture user's ownership to root without bypassing mode/type checks.
                real_lstat = pathlib.Path.lstat
                def root_lstat(item, *args, **kwargs):
                    result = list(real_lstat(item, *args, **kwargs))
                    if result[4] == os.getuid(): result[4] = 0
                    return os.stat_result(result)
                with patch.object(pathlib.Path, 'lstat', root_lstat):
                    original(path, directory)
        replacement = patch.dict(namespace, {'trusted': trusted_fixture})
        replacement.start()
        self.addCleanup(replacement.stop)
        if os.getuid() != 0:
            real_fstat, real_fchown = os.fstat, os.fchown
            def root_fstat(descriptor):
                result = list(real_fstat(descriptor))
                if result[4] == os.getuid(): result[4] = 0
                return os.stat_result(result)
            def fixture_fchown(descriptor, uid, gid):
                real_fchown(descriptor, os.getuid() if uid == 0 else uid, gid)
            for name, function in [('fstat', root_fstat), ('fchown', fixture_fchown)]:
                replacement = patch.object(os, name, function)
                replacement.start()
                self.addCleanup(replacement.stop)
        self.write_config()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config) + '\n')
        self.config_path.chmod(0o640)

    def sync(self):
        namespace['sync_host_config'](self.marker)

    def test_reboot_sync_preserves_metadata_and_other_fields(self):
        before = self.config_path.stat()
        if os.geteuid() == 0:
            os.chown(self.config_path, 0, 123)
            before = self.config_path.stat()
        self.sync()
        after = self.config_path.stat()
        self.assertNotEqual(before.st_ino, after.st_ino)
        self.assertEqual((before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                         (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)))
        expected = copy.deepcopy(self.config)
        expected['quotaDevice'] = '/dev/loop6'
        self.assertEqual(json.loads(self.config_path.read_text()), expected)
        self.sync()
        self.assertEqual(after.st_ino, self.config_path.stat().st_ino)
        self.assertEqual(sorted(item.name for item in self.root.iterdir()), ['sandbox-host.json', 'tenant-data'])

    def test_absent_and_synthetic_configs_are_untouched(self):
        self.config_path.unlink()
        self.sync()
        self.assertFalse(self.config_path.exists())
        self.config = {'schema': 1, 'synthetic': True, 'quotaBackingFile': '/fixture.img'}
        self.write_config()
        before = self.config_path.read_bytes()
        self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)

    def scoped_roots(self, branch='live'):
        parent = self.mount / branch
        parent.mkdir(mode=0o755)
        parent.chmod(0o755)
        for name in ['instances', 'native']:
            child = parent / name
            child.mkdir(mode=0o755)
            child.chmod(0o755)
            self.config['roots'][name] = str(child)
        self.write_config()
        return parent

    def test_default_production_flag_and_scoped_live_roots_are_supported(self):
        del self.config['synthetic']
        self.scoped_roots()
        self.sync()
        self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop6')
        self.assertEqual(json.loads(self.config_path.read_text())['roots'], self.config['roots'])

    def test_unmatched_pairs_and_untrusted_scoped_parent_fail_without_changes(self):
        parent = self.scoped_roots()
        before = self.config_path.read_bytes()
        parent.chmod(0o777)
        with self.assertRaises(ValueError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)
        parent.chmod(0o755)
        real_lstat = pathlib.Path.lstat
        def foreign_owner(path, *args, **kwargs):
            result = list(real_lstat(path, *args, **kwargs))
            if path == parent: result[4] = 123
            return os.stat_result(result)
        with patch.object(pathlib.Path, 'lstat', foreign_owner):
            with self.assertRaises(ValueError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)
        self.config['roots']['native'] = self.marker['native']
        self.write_config()
        before = self.config_path.read_bytes()
        with self.assertRaises(ValueError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_scoped_roots_reject_symlink_parent_and_other_filesystem(self):
        parent = self.scoped_roots()
        before = self.config_path.read_bytes()
        real_stat = pathlib.Path.stat
        def other_filesystem(path, *args, **kwargs):
            result = list(real_stat(path, *args, **kwargs))
            if path == parent / 'native': result[2] += 1
            return os.stat_result(result)
        with patch.object(pathlib.Path, 'stat', other_filesystem):
            with self.assertRaises(ValueError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)
        destination = self.root / 'outside'
        parent.rename(destination)
        parent.symlink_to(destination, target_is_directory=True)
        with self.assertRaises(ValueError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_invalid_production_identity_or_roots_fail_without_changes(self):
        original = copy.deepcopy(self.config)
        patches = [{'schema': 2}, {'synthetic': 'false'}, {'quotaCapacity': 1},
                   {'quotaBackingFile': '/fixture.img'},
                   {'roots': {'instances': str(self.mount), 'native': self.marker['native']}},
                   {'roots': {'instances': str(self.root / 'tenant-data-other'), 'native': self.marker['native']}},
                   {'roots': {'instances': self.marker['instances'], 'native': self.marker['instances']}},
                   {'roots': {'instances': self.marker['instances'] + '/../instances', 'native': self.marker['native']}}]
        for changes in patches:
            with self.subTest(changes=changes):
                self.config = {**original, **changes}
                self.write_config()
                before = self.config_path.read_bytes()
                with self.assertRaises(ValueError): self.sync()
                self.assertEqual(self.config_path.read_bytes(), before)

    def test_untrusted_configs_and_symlink_roots_fail_without_changes(self):
        self.config_path.chmod(0o660)
        with self.assertRaises(ValueError): self.sync()
        self.config_path.chmod(0o640)
        target = self.root / 'target.json'
        self.config_path.rename(target)
        self.config_path.symlink_to(target)
        with self.assertRaises(ValueError): self.sync()
        self.config_path.unlink()
        target.rename(self.config_path)
        (self.mount / 'instances').rmdir()
        (self.mount / 'instances').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): self.sync()
        if os.geteuid() == 0:
            os.chown(self.config_path, 123, 123)
            with self.assertRaises(ValueError): self.sync()

    def test_atomic_replace_failure_preserves_original_and_cleans_temporary(self):
        before = self.config_path.read_bytes()
        with patch.object(os, 'replace', side_effect=OSError('fixture replace failure')):
            with self.assertRaises(OSError): self.sync()
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(sorted(item.name for item in self.root.iterdir()), ['sandbox-host.json', 'tenant-data'])

    def test_prepare_syncs_only_after_verified_mount_and_backing(self):
        image = namespace['IMAGE']
        with image.open('wb') as output: output.truncate(namespace['CAPACITY'])
        image.chmod(0o600)
        marker_path = self.root / 'tenant-quota.json'
        marker_path.write_text(json.dumps(self.marker))
        marker_path.chmod(0o600)
        backing = self.root / 'backing_file'
        backing.write_text(str(image))
        mount = {'target': str(self.mount), 'source': '/dev/loop6', 'fstype': 'ext4',
                 'options': 'rw,nodev,nosuid,prjquota'}
        original_read = pathlib.Path.read_text
        def read_backing(path, *args, **kwargs):
            if str(path).startswith('/sys/class/block/'):
                return backing.read_text()
            return original_read(path, *args, **kwargs)
        with patch.dict(namespace, {'MARKER': marker_path, 'reserve_backing': lambda: None}), \
             patch.object(sys, 'argv', [sys.argv[0]]), patch.object(os, 'geteuid', return_value=0), \
             patch.object(pathlib.Path, 'read_text', read_backing), \
             patch.dict(namespace, {'command': lambda args: json.dumps({'filesystems': [mount]})}):
            for changes in [{'target': str(self.root)}, {'source': '/dev/sda'}, {'fstype': 'tmpfs'}]:
                original = dict(mount)
                mount.update(changes)
                with self.assertRaises(ValueError): namespace['prepare']()
                self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop11')
                mount.clear()
                mount.update(original)
            backing.write_text('/wrong/image.img')
            with self.assertRaises(ValueError): namespace['prepare']()
            self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop11')
            backing.write_text(str(image))
            namespace['prepare']()
            self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop6')
            # A reboot can leave the mount absent as well as change the loop number.
            self.write_config()
            calls = []
            def remount_command(args):
                calls.append(args)
                if args[0].endswith('findmnt'):
                    result = mount if len(calls) > 1 else {**mount, 'target': str(self.root)}
                    return json.dumps({'filesystems': [result]})
                self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop11')
                return '/dev/loop6' if args[0].endswith('losetup') else ''
            with patch.dict(namespace, {'command': remount_command}): namespace['prepare']()
            self.assertEqual([pathlib.Path(args[0]).name for args in calls], ['findmnt', 'losetup', 'mount', 'findmnt'])
            self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop6')
            self.write_config()
            marker_before = marker_path.read_bytes()
            for changes in [{'synthetic': True}, {'capacity': 1}, {'image': '/wrong.img'}, {'native': '/wrong/native'}]:
                marker_path.write_text(json.dumps({**self.marker, **changes}))
                with self.assertRaises(ValueError): namespace['prepare']()
                self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop11')
            marker_path.write_bytes(marker_before)
            with image.open('wb') as output: output.truncate(1)
            with self.assertRaises(ValueError): namespace['prepare']()
            self.assertEqual(json.loads(self.config_path.read_text())['quotaDevice'], '/dev/loop11')

unittest.main(argv=[sys.argv[0]])
`;

test("tenant volume reboot sync is trusted, atomic and bound to production storage", () => {
  assert.doesNotThrow(() => execFileSync("python3", ["-B", "-c", fixture, script], {
    encoding: "utf8", timeout: 15_000,
  }));
});

test("sandbox host requires volume preparation before its private mount namespace starts", () => {
  const host = readFileSync(new URL("../infra/scikeel-sandbox-host.service", import.meta.url), "utf8");
  assert.match(host, /^Requires=.*\bscikeel-tenant-volume\.service\b/m);
  assert.match(host, /^After=.*\bscikeel-tenant-volume\.service\b/m);
  const volume = readFileSync(new URL("../infra/scikeel-tenant-volume.service", import.meta.url), "utf8");
  // A skipped production volume unit must still allow the synthetic fixture host.
  assert.match(volume, /^ConditionPathExists=\/var\/lib\/scikeel\/tenant-quota\.json$/m);
});
