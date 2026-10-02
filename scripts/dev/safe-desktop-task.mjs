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
// Linked worktrees must serialize with the main checkout, not just themselves.
const gitCommon = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: root, encoding: "utf8" });
const sharedTaskRoot = gitCommon.status === 0
  ? join(dirname(gitCommon.stdout.trim()), ".deploy") : stagingRoot;
const mode = process.argv[2];
const guarded = process.argv[3] === "--guarded";
const args = process.argv.slice(guarded ? 4 : 3);
const smallLinuxHost = process.platform === "linux" && (totalmem() < 5 * 1024 ** 3 || process.env.OSD_TASK_FORCE_LIMITS === "1");
const mib = 1024 ** 2;
const memoryHigh = 1850 * mib;
const memoryMax = 2200 * mib;
const swapMax = 256 * mib;

if (!["build", "test", "typecheck", "lint", "probe", "platform-test",
  "core-test", "core-check", "core-build", "sandbox-probe", "sandbox-image-stage"].includes(mode)) {
  console.error("Unknown guarded task mode");
  process.exit(2);
}

function run(command, commandArgs, cwd = desktop) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
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
  await mkdir(sharedTaskRoot, { recursive: true });
  const unit = `osd-task-${process.pid}-${Date.now()}.scope`;
  await new Promise((done, fail) => {
    const child = spawn("flock", [
      "-n", join(sharedTaskRoot, "desktop-task.lock"),
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

function coreArgs() {
  // Never permit the desktop package, arbitrary Cargo flags or manifest paths.
  const [flag, name, filter, ...extra] = args;
  if (flag !== "--package" || !["osd-core", "osd-cli", "osd-sandbox-host"].includes(name) ||
      extra.length || (filter !== undefined &&
        (mode !== "core-test" || !/^[A-Za-z0-9_:]+$/.test(filter)))) {
    throw new Error("Core tasks require --package osd-core|osd-cli|osd-sandbox-host and an optional test filter");
  }
  return [mode === "core-test" ? "test" : mode === "core-build" ? "build" : "check", "--locked", "--jobs", "1", "--package", name,
    ...(filter ? [filter] : []), ...(mode === "core-test" ? ["--", "--test-threads=1"] : [])];
}

if (smallLinuxHost) verifyLimits();
if (mode === "probe") {
  console.log(smallLinuxHost ? "Resource limits active" : "Host does not need cloud resource limits");
} else if (mode === "platform-test") {
  run(process.execPath, ["--test", "--test-concurrency=1", ...args], join(root, "services/platform"));
} else if (mode === "core-test" || mode === "core-check" || mode === "core-build") {
  run("cargo", coreArgs(), root);
} else if (mode === "sandbox-probe" || mode === "sandbox-image-stage") {
  const entry = mode === "sandbox-probe" ? "sandbox-probe.mjs" : "stage-sandbox-image.mjs";
  run(process.execPath, [join(root, "scripts/dev", entry), ...args], root);
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
  run(process.execPath, [join(root, "scripts/dev/build-web-vendor.mjs")]);

  // Never empty a deployed dist directory before a successful replacement.
  const stage = smallLinuxHost ? await mkdtemp(join(stagingRoot, "web-build-")) : null;
  try {
    run(process.execPath, [
      `--max-old-space-size=${smallLinuxHost ? 1024 : 4096}`,
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
