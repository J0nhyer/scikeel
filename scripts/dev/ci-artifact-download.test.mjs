import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('artifact transport validates exact ranges and rejects unsafe ZIP inventories before installation', () => {
  const script = fileURLToPath(new URL('./download-ci-artifact.py', import.meta.url));
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util, tempfile, pathlib, zipfile
spec = importlib.util.spec_from_file_location('artifact', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.validate_range('bytes 0-9/20', 0, 9, 20)
try: module.validate_range('bytes 0-9/21', 0, 9, 20)
except ValueError: pass
else: raise AssertionError('Range identity mismatch accepted')
with tempfile.TemporaryDirectory() as root:
 root = pathlib.Path(root); target = root / 'output'; target.mkdir(); archive = root / 'artifact.zip'
 for unsafe in ('../escape', '/escape', 'unexpected-file'):
  with zipfile.ZipFile(archive, 'w') as out: out.writestr(unsafe, b'fixture')
  try: module.extract_artifact(archive, target)
  except ValueError: pass
  else: raise AssertionError('Unsafe artifact entry accepted')
 with zipfile.ZipFile(archive, 'w') as out:
  for name in module.ALLOWED: out.writestr(name, b'fixture')
 module.extract_artifact(archive, target)
 assert (target / 'image-manifest.json').read_bytes() == b'fixture'
`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
