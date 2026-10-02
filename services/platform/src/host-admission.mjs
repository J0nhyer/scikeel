import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { posix } from "node:path";

const unavailable = () => Object.assign(new Error("host resource capacity unavailable"), { statusCode: 503, retryable: true });
export async function hostPressure() {
  const [memory, pressure] = await Promise.all([readFile("/proc/meminfo", "utf8"), readFile("/proc/pressure/memory", "utf8")]);
  const availableBytes = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
  const fullAvg10 = Number(pressure.match(/^full avg10=([\d.]+)/m)?.[1]);
  if (!Number.isSafeInteger(availableBytes) || !Number.isFinite(fullAvg10) || fullAvg10 > 12) throw unavailable();
  // The atomic lock, not this observation, excludes heavy builds.
  return { availableBytes, buildActive: false };
}
export class HostAdmission {
  constructor({ lockPath = "/opt/open-science-desktop/.deploy/desktop-task.lock" } = {}) {
    if (typeof lockPath !== "string" || !lockPath.startsWith("/") || lockPath === "/" || posix.normalize(lockPath) !== lockPath || /[\0\\]/.test(lockPath))
      throw new Error("invalid host admission lock");
    this.lockPath = lockPath;
  }
  async acquire({ signal } = {}) {
    if (signal?.aborted) throw new Error("host admission cancelled");
    const file = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = await file.stat();
    if (!info.isFile()) { await file.close(); throw unavailable(); }
    let child;
    try {
      // Pass an already-open descriptor: flock cannot follow a replaced pathname.
      child = spawn("/usr/bin/flock", ["-n", "-F", "/proc/self/fd/3", process.execPath, "-e",
        'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write("ready\\n");'], {
        env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore", file.fd],
      });
    } finally { await file.close(); }
    let released; let closed = false;
    const completion = new Promise((done) => child.once("close", () => { closed = true; done(); }));
    const release = () => released ??= (async () => {
      if (closed) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await completion; } finally { clearTimeout(timer); }
    })();
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); child.off("error", fail); child.off("close", fail); child.stdout.off("data", ready); };
        const fail = () => { cleanup(); reject(unavailable()); };
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
