import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, commonStore, inspectProduction } from './web-release-source.mjs';
import { productionFingerprint } from './web-release.mjs';
import { verifyTaskLocks } from './web-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function withProjectMaintenance(ops, action) {
  const previous = await ops.inspect();
  try { await ops.stop(); return await action(previous); }
  finally { await ops.start(); }
}
export async function maintenancePrepare(args, { store, id, locked = false, boot = false } = {}) {
  if (process.platform !== 'linux') throw new Error('Workspace maintenance requires Linux systemd');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || store !== commonStore(root)) throw new Error('Unsafe maintenance request');
  if (!locked) {
    const result = spawnSync('flock', ['--conflict-exit-code', '75', '-n', join(store, 'web-release-deploy.lock'), process.execPath, '--max-old-space-size=128', fileURLToPath(import.meta.url), 'owner', id, JSON.stringify(args)], { cwd: root, stdio: 'inherit' });
    if (result.status === 75) throw new Error('Another update is already running');
    if (result.error || result.status !== 0) throw new Error('Maintenance preparation failed; previous Web deployment retained');
    return;
  }
  verifyTaskLocks({ publicationOnly: !boot });
  if (boot) {
    command('sudo', ['-n', 'systemctl', 'start', 'osd-platform.service']);
    const unit = `osd-task-${process.pid}-${Date.now()}.scope`;
    await new Promise((done, fail) => {
      const child = spawn('systemd-run', ['--user', '--scope', `--unit=${unit}`, '-p', 'MemoryHigh=1850M', '-p', 'MemoryMax=2200M', '-p', 'MemorySwapMax=256M', 'nice', '-n', '10', 'pnpm', 'release:worker', ...args], { cwd: root, stdio: 'inherit' });
      let bad = 0; let stopped = false;
      const timer = setInterval(() => {
        try {
          const memory = readFileSync('/proc/meminfo', 'utf8');
          const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
          const pressure = Number(readFileSync('/proc/pressure/memory', 'utf8').match(/^full avg10=([\d.]+)/m)?.[1]);
          bad = !Number.isFinite(available) || !Number.isFinite(pressure) || available < 600 * 1024 ** 2 || pressure > 12 ? bad + 1 : 0;
        } catch { bad++; }
        if (bad < 2 || stopped) return;
        stopped = true; command('systemctl', ['--user', 'stop', unit], { timeout: 5000 });
      }, 2000);
      child.once('error', (error) => { clearInterval(timer); fail(error); });
      child.once('close', (code) => { clearInterval(timer); code === 0 && !stopped ? done() : fail(new Error('Bounded maintenance task failed')); });
    });
    return;
  }
  const before = await inspectProduction();
  console.log('Maintenance: pause project workloads, retain the current Web bundle, and restore the platform during bounded verification');
  await withProjectMaintenance({ inspect: () => before,
    stop: () => command('sudo', ['-n', 'systemctl', 'stop', 'osd-platform.service']),
    start: () => command('sudo', ['-n', 'systemctl', 'start', 'osd-platform.service']) }, async () => {
    const result = spawnSync('flock', ['--conflict-exit-code', '75', '-n', join(store, 'desktop-task.lock'), process.execPath, '--max-old-space-size=128', fileURLToPath(import.meta.url), 'boot', id, JSON.stringify(args)], { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Maintenance preparation failed');
  });
  if (productionFingerprint(await inspectProduction()) !== productionFingerprint(before)) throw new Error('Maintenance changed the existing deployment identity');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await maintenancePrepare(JSON.parse(process.argv[4]), { store: commonStore(root), id: process.argv[3], locked: true, boot: process.argv[2] === 'boot' }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
