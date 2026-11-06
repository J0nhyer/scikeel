import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { posix } from "node:path";
import { capacityError } from "./workspace-capacity.mjs";

const unavailable = () => Object.assign(new Error("host resource capacity unavailable"), { statusCode: 503, retryable: true });
export async function hostPressure({ mode = "legacy", readFileImpl = readFile, cgroupRoot = "/sys/fs/cgroup" } = {}) {
  if (!["legacy", "docker"].includes(mode)) throw new Error("invalid host pressure mode");
  const memory = await readFileImpl("/proc/meminfo", "utf8");
  let availableBytes = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
  if (!Number.isSafeInteger(availableBytes)) throw new Error("invalid host memory observation");
  let pressure;
  try { pressure = await readFileImpl("/proc/pressure/memory", "utf8"); }
  catch (error) { if (mode !== "docker" || error.code !== "ENOENT") throw error; }
  const fullAvg10 = pressure === undefined ? 0 : Number(pressure.match(/^full avg10=([\d.]+)/m)?.[1]);
  if (!Number.isFinite(fullAvg10)) throw new Error("invalid host memory observation");
  if (mode === "docker") {
    const optional = async (name) => {
      try { return await readFileImpl(posix.join(cgroupRoot, name), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    };
    const maximum = await optional("memory.max");
    const current = await optional("memory.current");
    if (maximum !== null && maximum.trim() !== "max" && current !== null) {
      const max = Number(maximum.trim());
      const used = Number(current.trim());
      if (!Number.isSafeInteger(max) || !Number.isSafeInteger(used) || max < 1 || used < 0)
        throw new Error("invalid cgroup memory observation");
      availableBytes = Math.min(availableBytes, Math.max(0, max - used));
    }
  }
  if (fullAvg10 > 12) throw capacityError("memory_pressure", { fullAvg10, availableBytes });
  // The atomic lock, not this observation, excludes heavy builds.
  return { availableBytes, buildActive: false };
}
export class HostAdmission {
  constructor({ mode = "legacy", lockPath = "/opt/open-science-desktop/.deploy/desktop-task.lock", pressureImpl = hostPressure } = {}) {
    if (!["legacy", "docker"].includes(mode)) throw new Error("invalid host admission mode");
    if (typeof pressureImpl !== "function") throw new Error("invalid host admission pressure");
    if (typeof lockPath !== "string" || !lockPath.startsWith("/") || lockPath === "/" || posix.normalize(lockPath) !== lockPath || /[\0\\]/.test(lockPath))
      throw new Error("invalid host admission lock");
    this.mode = mode; this.lockPath = lockPath; this.pressureImpl = pressureImpl;
  }
  async acquire({ signal,shared=false } = {}) {
    if(typeof shared!=='boolean')throw new Error('invalid host admission mode');
    if (signal?.aborted) throw new Error("host admission cancelled");
    if (this.mode === "docker") {
      await this.pressureImpl({ mode: "docker" });
      return { release() {} };
    }
    const file = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = await file.stat();
    if (!info.isFile()) { await file.close(); throw unavailable(); }
    let child; let closed = false; let startError; let completion; let exitCode;
    try {
      // Pass an already-open descriptor: flock cannot follow a replaced pathname.
      child = spawn("/usr/bin/flock", ["-n",...(shared?["-s"]:[]), "-F", "/proc/self/fd/3", process.execPath, "-e",
        'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write("ready\\n");'], {
        env: { PATH: "/usr/bin:/bin",...Object.fromEntries(['TMPDIR','TMP','TEMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])) }, stdio: ["pipe", "pipe", "ignore", file.fd],
      });
      // Subscribe before yielding: a rejected flock can exit while the fd closes.
      completion = new Promise((done) => child.once("close", code => { closed = true; exitCode = code; done(); }));
      child.once("error", error => { startError = error; });
      child.stdin.on("error", () => {});
    } finally { await file.close(); }
    let released;
    const release = () => released ??= (async () => {
      if (closed) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await completion; } finally { clearTimeout(timer); }
    })();
    try {
      const rejected = () => startError ?? (exitCode === 1 ? capacityError("build_lock") : unavailable());
      if (closed || startError) throw rejected();
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); child.off("error", fail); child.off("close", fail); child.stdout.off("data", ready); };
        const fail = () => { cleanup(); reject(rejected()); };
        const abort = () => { cleanup(); reject(new Error("host admission cancelled")); };
        const ready = (bytes) => { cleanup(); bytes.toString() === "ready\n" ? resolve() : reject(unavailable()); };
        const timer = setTimeout(fail, 3000);
        child.once("error", fail); child.once("close", fail); child.stdout.once("data", ready);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return Object.freeze({ release });
    } catch (error) { await release(); throw error; }
  }
}
