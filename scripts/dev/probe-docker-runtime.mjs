import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BENCHMARK_SCRIPT = `import time
t = time.perf_counter()
x = 0
for i in range(5000000):
    x += i
print(time.perf_counter() - t)
`;

function invalidBenchmark() {
  const error = new Error("invalid_benchmark");
  error.code = "invalid_benchmark";
  return error;
}

export function classifyBenchmark({ amd64Ms, arm64Ms }) {
  if (!Number.isFinite(amd64Ms) || !Number.isFinite(arm64Ms) || amd64Ms <= 0 || arm64Ms <= 0) {
    throw invalidBenchmark();
  }
  const ratio = Math.round((amd64Ms / arm64Ms) * 1000) / 1000;
  return { decision: ratio <= 4 ? "accept" : "fallback", ratio };
}

function run(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function elapsedSeconds(output) {
  const line = output.trim().split("\n").filter(Boolean).at(-1);
  const seconds = Number(line);
  if (!Number.isFinite(seconds) || seconds <= 0) throw invalidBenchmark();
  return seconds;
}

function benchmarkArgs(platform) {
  return ["run", "--rm", "--platform", platform, "python:3.12-slim", "python", "-c", BENCHMARK_SCRIPT];
}

export async function probe({ runImpl = run } = {}) {
  const docker = runImpl(["info", "--format", "{{.Architecture}}"]).trim();
  const amd64 = runImpl(["run", "--rm", "--platform", "linux/amd64", "alpine", "uname", "-m"]).trim();
  const arm64 = runImpl(["run", "--rm", "--platform", "linux/arm64", "alpine", "uname", "-m"]).trim();
  const amd64Ms = elapsedSeconds(runImpl(benchmarkArgs("linux/amd64"))) * 1000;
  const arm64Ms = elapsedSeconds(runImpl(benchmarkArgs("linux/arm64"))) * 1000;
  const benchmark = classifyBenchmark({ amd64Ms, arm64Ms });
  return {
    docker,
    platform: `${process.platform}/${process.arch}`,
    amd64,
    arm64,
    amd64Ms: Math.round(amd64Ms),
    arm64Ms: Math.round(arm64Ms),
    ...benchmark,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  probe().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
