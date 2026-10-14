import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('analytics dependency installation stays behind the existing host guard', async () => {
  const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.match(root.scripts['platform:deps-install'] ?? '', /safe-desktop-task\.mjs platform-deps-install$/);
  const guard = await readFile(new URL('./safe-desktop-task.mjs', import.meta.url), 'utf8');
  assert.match(guard, /Dependency installation has fixed inputs/);
  const platform = JSON.parse(await readFile(new URL('../../services/platform/package.json', import.meta.url)));
  assert.equal(platform.dependencies['better-sqlite3'], '12.9.0');
});
