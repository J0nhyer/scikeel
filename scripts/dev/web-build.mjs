import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyTaskLimits() {
  if (process.platform !== 'linux' || (totalmem() >= 5 * 1024 ** 3 && process.env.OSD_TASK_FORCE_LIMITS !== '1')) return;
  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  if (!cgroup) throw new Error('Missing verified task cgroup');
  const limit = (name) => Number(readFileSync(join('/sys/fs/cgroup', cgroup, name), 'utf8').trim());
  verifyTaskLocks();
  if (!(limit('memory.high') <= 1850 * 1024 ** 2 && limit('memory.max') <= 2200 * 1024 ** 2 && limit('memory.swap.max') <= 256 * 1024 ** 2))
    throw new Error('Task limits are not active');
}
export function verifyTaskLocks({ publicationOnly = false } = {}) {
  if (process.platform !== 'linux' || (totalmem() >= 5 * 1024 ** 3 && process.env.OSD_TASK_FORCE_LIMITS !== '1' && !publicationOnly)) return;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot identify shared task lock root');
  const store = join(dirname(result.stdout.trim()), '.deploy');
  const ancestors = new Set(); let pid = process.pid;
  while (pid > 1 && !ancestors.has(pid)) {
    ancestors.add(pid);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  const locks = readFileSync('/proc/locks', 'utf8').split('\n');
  for (const name of publicationOnly ? ['web-release-deploy.lock'] : ['web-release-deploy.lock', 'desktop-task.lock']) {
    const stat = statSync(join(store, name), { bigint: true });
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
    const owned = locks.some((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || !ancestors.has(Number(fields[4]))) return false;
      const [a, b, inode] = (fields[5] ?? '').split(':');
      return a && b && inode && BigInt('0x' + a) === major && BigInt('0x' + b) === minor && BigInt(inode) === stat.ino;
    });
    if (!owned) throw new Error(`Shared task lock not inherited: ${name}`);
  }
}
export function runProcess(binary, args, cwd, environment = {}) {
  verifyTaskLimits();
  const result = spawnSync(binary, args, { cwd, stdio: 'inherit', env: { ...process.env, ...environment } });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Guarded subprocess failed: ${binary.split('/').at(-1)}`);
}
export async function runWebStages(options) {
  const { profile, sourceFingerprint, checkedFingerprint, check, acp, vendor, bundle } = options;
  if (!['desktop', 'web', 'release'].includes(profile)) throw new Error('Invalid build profile');
  if (profile === 'release') {
    if (!sourceFingerprint || sourceFingerprint !== checkedFingerprint) throw new Error('Candidate typecheck does not match source');
  } else await check();
  if (profile === 'desktop') await acp();
  await vendor(); return bundle();
}
export async function buildWeb({ root, profile = 'web', sourceFingerprint, checkedStage, vendorDirectory, outDir, store }) {
  verifyTaskLimits();
  const desktop = join(root, 'apps/desktop');
  const staging = store ?? join(root, '.deploy');
  const small = process.platform === 'linux' && (totalmem() < 5 * 1024 ** 3 || process.env.OSD_TASK_FORCE_LIMITS === '1');
  const stageOnly = profile !== 'desktop' || process.env.OSD_WEB_STAGE_ONLY === '1';
  await mkdir(staging, { recursive: true });
  const stage = outDir ?? (small || stageOnly ? await mkdtemp(join(staging, 'web-build-')) : join(desktop, 'dist'));
  let retained = false;
  try {
    await runWebStages({ profile, sourceFingerprint,
      checkedFingerprint: checkedStage?.status === 'passed' ? checkedStage.inputFingerprint : null,
      check: () => runProcess(process.execPath, [join(desktop, 'node_modules/typescript/bin/tsc'), '--noEmit'], desktop),
      acp: () => runProcess(process.execPath, [join(root, 'scripts/build-acp-server.mjs')], desktop),
      vendor: async () => {
        if (vendorDirectory) return;
        const { ensureVendorCache } = await import('./web-vendor-cache.mjs');
        const cache = await ensureVendorCache({ root, store: join(staging, 'web-vendor-cache') });
        vendorDirectory = cache.directory;
        console.log(`Vendor cache ${cache.hit ? 'hit' : 'miss'}: ${cache.key}`);
      },
      bundle: () => runProcess(process.execPath, [`--max-old-space-size=${small ? 1024 : 4096}`, join(desktop, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', stage, '--emptyOutDir'], desktop, { OSD_WEB_VENDOR_DIR: vendorDirectory }),
    });
    if (!existsSync(join(stage, 'index.html')) || !(await readdir(join(stage, 'assets'))).length) throw new Error('Staged Web output is incomplete');
    if (stageOnly || outDir) {
      retained = true;
      if (profile !== 'release') await writeFile(join(staging, 'attachments-build-path'), stage + '\n');
      console.log(`Web build staged at ${stage}`); return { directory: stage };
    }
    const dist = join(desktop, 'dist');
    if (stage !== dist) {
      const backup = join(staging, `web-before-${Date.now()}-${process.pid}`);
      if (existsSync(dist)) await rename(dist, backup);
      try { await rename(stage, dist); }
      catch (error) { if (existsSync(backup)) await rename(backup, dist); throw error; }
      console.log(`Web bundle replaced; previous bundle at ${backup}`);
    }
    retained = true; return { directory: dist };
  } finally {
    if (!retained && stage !== join(desktop, 'dist') && existsSync(stage)) await rm(stage, { recursive: true, force: true });
  }
}
