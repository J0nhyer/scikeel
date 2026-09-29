// Keep build and test resource usage bounded on small Linux hosts. A cgroup
// limit covers Vite, its workers, TypeScript, and any subprocesses; a V8 heap
// flag alone cannot protect the host. Other platforms keep their normal build.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../..");
const desktop = join(root, "apps/desktop");
const stagingRoot = join(root, ".deploy");
const mode = process.argv[2];
const guarded = process.argv[3] === "--guarded";
const args = process.argv.slice(guarded ? 4 : 3);
const smallLinuxHost = process.platform === "linux" && totalmem() < 5 * 1024 ** 3;
const mib = 1024 ** 2;
const memoryHigh = 1850 * mib;
const memoryMax = 2200 * mib;
const swapMax = 256 * mib;

if (!["build", "test", "typecheck", "lint", "probe"].includes(mode)) {
  console.error("Usage: safe-desktop-task.mjs build|test|typecheck|lint|probe [args]");
  process.exit(2);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: desktop, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function verifyLimits() {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8").split("\n")
    .find((line) => line.startsWith("0::"))?.slice(3);
  if (!cgroup) throw new Error("No unified cgroup; refusing to run an unprotected task");
  const readLimit = (name) => Number(readFileSync(join("/sys/fs/cgroup", cgroup, name), "utf8").trim());
  if (!(readLimit("memory.high") <= memoryHigh &&
        readLimit("memory.max") <= memoryMax &&
        readLimit("memory.swap.max") <= swapMax)) {
    throw new Error("Resource limits are missing; refusing to run an unprotected task");
  }
}

if (smallLinuxHost && !guarded) {
  // This lock includes tests and builds, so they cannot compete for the host.
  // Fail closed if either flock or the user systemd manager is unavailable.
  await mkdir(stagingRoot, { recursive: true });
  const unit = `osd-task-${process.pid}-${Date.now()}.scope`;
  await new Promise((done, fail) => {
    const child = spawn("flock", [
      "-n", join(stagingRoot, "desktop-task.lock"),
      "systemd-run", "--user", "--scope", `--unit=${unit}`,
      "-p", "MemoryHigh=1850M", "-p", "MemoryMax=2200M", "-p", "MemorySwapMax=256M",
      "nice", "-n", "10", process.execPath, script, mode, "--guarded", ...args,
    ], { cwd: desktop, stdio: "inherit" });
    let unsafeReadings = 0;
    let stoppedForPressure = false;
    const monitor = setInterval(() => {
      try {
        const info = readFileSync("/proc/meminfo", "utf8");
        const available = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
        const pressure = readFileSync("/proc/pressure/memory", "utf8");
        const fullAvg10 = Number(pressure.match(/^full avg10=([\d.]+)/m)?.[1]);
        // A cgroup OOM protects the kernel, but heavy swapping can still make
        // SSH unresponsive. Stop before a sustained host-wide stall develops.
        if (!Number.isFinite(available) || !Number.isFinite(fullAvg10) ||
            available < 600 * mib || fullAvg10 > 12) unsafeReadings++;
        else unsafeReadings = 0;
        if (unsafeReadings < 2) return;
        stoppedForPressure = true;
        clearInterval(monitor);
        console.error("Host memory pressure is too high; stopping the task and keeping the deployed site.");
        spawnSync("systemctl", ["--user", "stop", unit], { stdio: "inherit", timeout: 5000 });
      } catch {
        // Inability to inspect host memory must also stop a heavy task.
        unsafeReadings++;
        if (unsafeReadings >= 2) {
          stoppedForPressure = true;
          clearInterval(monitor);
          spawnSync("systemctl", ["--user", "stop", unit], { stdio: "inherit", timeout: 5000 });
        }
      }
    }, 2000);
    child.on("error", (error) => { clearInterval(monitor); fail(error); });
    child.on("close", (code) => {
      clearInterval(monitor);
      if (stoppedForPressure) fail(new Error("Task stopped to protect host responsiveness"));
      else if (code !== 0) fail(new Error(`Guarded task exited with status ${code}`));
      else done();
    });
  });
  process.exit(0);
}

if (smallLinuxHost) verifyLimits();
if (mode === "probe") {
  console.log(smallLinuxHost ? "Resource limits active" : "Host does not need cloud resource limits");
} else if (mode === "typecheck") {
  run(process.execPath, [join(desktop, "node_modules/typescript/bin/tsc"), "--noEmit", ...args]);
} else if (mode === "lint") {
  run(process.execPath, [join(desktop, "node_modules/eslint/bin/eslint.js"), ".", ...args]);
} else if (mode === "test") {
  // Vitest normally forks one worker per file; cap to one on the cloud host.
  run(process.execPath, [join(desktop, "node_modules/vitest/vitest.mjs"), "run",
    ...(smallLinuxHost ? ["--no-file-parallelism"] : []), ...args]);
} else if (mode === "build") {
  if (args.length) throw new Error("Build options are not supported by the guarded build");
  run(process.execPath, [join(desktop, "node_modules/typescript/bin/tsc"), "--noEmit"]);
  run(process.execPath, [join(root, "scripts/build-acp-server.mjs")]);

  // Never empty a deployed dist directory before a successful replacement.
  const stage = smallLinuxHost ? await mkdtemp(join(stagingRoot, "web-build-")) : null;
  try {
    run(process.execPath, [
      `--max-old-space-size=${smallLinuxHost ? 1350 : 4096}`,
      join(desktop, "node_modules/vite/bin/vite.js"), "build",
      ...(stage ? ["--outDir", stage, "--emptyOutDir"] : []),
    ]);
    if (stage) {
      if (!existsSync(join(stage, "index.html")) ||
          !(await readdir(join(stage, "assets"))).length) {
        throw new Error("Staged build is incomplete; the deployed site was not changed");
      }
      const dist = join(desktop, "dist");
      const backup = join(stagingRoot, `web-before-${Date.now()}-${process.pid}`);
      if (existsSync(dist)) await rename(dist, backup);
      try {
        await rename(stage, dist);
      } catch (error) {
        if (existsSync(backup)) await rename(backup, dist);
        throw error;
      }
      console.log(`Web build deployed; previous bundle saved at ${backup}`);
    }
  } finally {
    if (stage && existsSync(stage)) await rm(stage, { recursive: true });
  }
}
