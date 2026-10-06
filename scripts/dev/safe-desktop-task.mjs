// Keep build and test resource usage bounded on small Linux hosts. A cgroup
// limit covers Vite, its workers, TypeScript, and any subprocesses; a V8 heap
// flag alone cannot protect the host. Other platforms keep their normal build.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
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

if (!["opencode-title-acceptance", "opencode-title-check", "opencode-title-prepare", "opencode-title-test", "opencode-title-build", "build", "test", "typecheck", "lint", "probe", "platform-test", "release-test", "web-build", "release",
  "core-test", "core-check", "core-build", "sandbox-probe", "sandbox-image-stage", "sandbox-storage-prepare", "sandbox-host-prepare", "sandbox-network-test", "sandbox-mirror-lock", "sandbox-mirror-prepare", "sandbox-mirror-probe", "sandbox-mirror-install", "sandbox-migrate"].includes(mode)) {
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
      "--conflict-exit-code", "75", "-n", join(sharedTaskRoot, "web-release-deploy.lock"),
      "flock", "--conflict-exit-code", "75", "-n", join(sharedTaskRoot, "desktop-task.lock"),
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
      else if (code === 75) fail(new Error("Host is busy: another release or running workspace holds the shared resource lock"));
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

if (smallLinuxHost) {
  verifyLimits();
  const { verifyTaskLocks } = await import("./web-build.mjs");
  verifyTaskLocks();
}
if (mode === "release-test") {
  run(process.execPath, ["--test", "--test-concurrency=1", ...args], root);
} else if (mode === "probe") {
  console.log(smallLinuxHost ? "Resource limits active" : "Host does not need cloud resource limits");
} else if (mode === "platform-test") {
  run(process.execPath, ["--test", "--test-concurrency=1", ...args], join(root, "services/platform"));
} else if (mode.startsWith("opencode-title-")) {
  run(process.execPath, [join(root, "scripts/dev/build-opencode-title-runtime.mjs"), mode.slice("opencode-title-".length), ...args], root);
  process.exit(0);
}
if (mode === "core-test" || mode === "core-check" || mode === "core-build") {
  run("cargo", coreArgs(), root);
} else if (mode === "sandbox-network-test") {
  if (args.length) throw new Error("Kernel network tests have fixed isolated arguments");
  run("cargo", ["test", "--locked", "--jobs", "1", "--package", "osd-sandbox-host", "--",
    "--test-threads=1", "--ignored", "network::tests::kernel_policy_blocks_bypasses_and_detects_rule_changes", "--nocapture"], root);
} else if (mode === "sandbox-mirror-lock") {
  if (args.length) throw new Error("Mirror lock generation uses fixed inputs");
  run("/opt/open-science-desktop/.deploy/osd/releases/0.5.2/uv", ["pip", "compile", "--python", "/usr/bin/python3", "--generate-hashes",
    "--output-file", "runtime/sandbox/image/package-mirror.lock", "runtime/sandbox/image/package-mirror.in"], root);
} else if (mode === "sandbox-mirror-prepare") {
  if (args.length) throw new Error("Mirror fixture preparation uses fixed inputs");
  const uv = "/opt/open-science-desktop/.deploy/osd/releases/0.5.2/uv";
  const environment = join(stagingRoot, "package-mirror-fixture/venv");
  if (!existsSync(join(environment, "bin/python"))) run(uv, ["venv", "--python", "/usr/bin/python3", environment], root);
  run(uv, ["pip", "sync", "--require-hashes", "--only-binary", ":all:", "--python", join(environment, "bin/python"),
    ...(existsSync(join(stagingRoot, "mirror-wheels/wheels")) ? ["--no-index", "--find-links", join(stagingRoot, "mirror-wheels/wheels")] : []),
    "runtime/sandbox/image/package-mirror.lock"], root);
} else if (mode === "sandbox-mirror-probe") {
  if (args.length) throw new Error("Mirror acceptance uses fixed synthetic inputs");
  run(process.execPath, [join(root, "scripts/dev/probe-package-mirror.mjs")], root);
} else if (mode === "sandbox-migrate") {
  if (!["--dry-run --synthetic", "--dry-run --production", "--copy-stopped --production"].includes(args.join(" "))) throw new Error("Migration requires fixed synthetic or production arguments");
  run(process.execPath, [join(root, "scripts/dev/migrate-tenant-sandboxes.mjs"), ...args], root);
} else if (mode === "sandbox-mirror-install") {
  if (args.length) throw new Error("Mirror setup uses fixed verified inputs");
  run("sudo", ["-n", "/usr/bin/python3", "/usr/local/lib/scikeel/prepare-package-mirror.py"], root);
} else if (mode === "sandbox-host-prepare") {
  if (args.length) throw new Error("Host preparation has fixed synthetic arguments");
  run("sudo", ["-n", "/usr/bin/python3", "/usr/local/lib/scikeel/prepare-synthetic-host.py"], root);
} else if (mode === "sandbox-storage-prepare") {
  if (args.length && args.join(" ")!=="--production") throw new Error("Storage preparation has fixed verified arguments");
  run("sudo", ["-n", "/usr/bin/python3", `/usr/local/lib/scikeel/${args.length ? "prepare-tenant-volume.py" : "provision-synthetic-quota.py"}`], root);
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
 } else if (mode === "build" || mode === "web-build") {
  if (args.length) throw new Error("Build options are not supported by the guarded build");
  const { buildWeb } = await import("./web-build.mjs");
  await buildWeb({ root, profile: mode === "build" ? "desktop" : "web", store: stagingRoot });
} else if (mode === "release") {
  const { releaseWorker } = await import("./web-release.mjs");
  await releaseWorker(args, { root, sharedStore: sharedTaskRoot });
}
