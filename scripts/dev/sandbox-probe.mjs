import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createSandboxRig } from "../../services/platform/fixtures/sandbox-rig.mjs";
import { SandboxClient } from "../../services/platform/src/sandbox-client.mjs";
import { readFile, lstat } from "node:fs/promises";
import { probeSyntheticScience } from "./probe-synthetic-science.mjs";

export function parseCgroupLimit(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim()))
    throw new Error("invalid cgroup limit");
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid cgroup limit");
  return parsed;
}

export function assertScopeLimits(v) {
  const cpu = /^(\d+) (\d+)$/.exec(v.cpuMax ?? "");
  const quota = cpu && Number(cpu[1]);
  const period = cpu && Number(cpu[2]);
  if (!Number.isSafeInteger(v.memoryMax) || v.memoryMax > 1073741824 || v.memoryMax <= 0 ||
      !Number.isSafeInteger(v.swapMax) || v.swapMax > 134217728 || v.swapMax < 0 ||
      !Number.isSafeInteger(v.pidsMax) || v.pidsMax > 256 || v.pidsMax <= 0 ||
      !Number.isSafeInteger(quota) || !Number.isSafeInteger(period) ||
      quota <= 0 || period <= 0 || quota > period || v.childrenOwned !== true) {
    throw new Error("unenforced sandbox limits");
  }
}

export async function runProbe(args) {
  if (args.length !== 2 || args[0] !== "--case")
    throw new Error("Usage: sandbox:probe --case preflight");
  if (args[1] === "storage") {
    const result = spawnSync("sudo", ["-n", "/usr/bin/python3", "/usr/local/lib/scikeel/probe-synthetic-quota.py"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    if (result.error || result.status !== 0) throw new Error("kernel quota probe failed");
    const evidence = JSON.parse(result.stdout);
    if (evidence.scope !== "synthetic-volume-kernel" || !evidence.byteLimitRejected || !evidence.inodeLimitRejected || !evidence.peerUnaffected)
      throw new Error("incomplete kernel quota evidence");
    console.log(JSON.stringify({ case: "storage", evidence })); return;
  }
  if (args[1] === "science-image") {
    const path = "/etc/scikeel/sandbox-test.json";
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 65536)
      throw new Error("untrusted synthetic test configuration");
    const config = JSON.parse(await readFile(path, "utf8"));
    if (config.schema !== 1 || config.synthetic !== true || config.launcherSocket !== "/run/scikeel/host.sock" ||
        config.accountPrefix !== "sandbox-test-") throw new Error("invalid synthetic test configuration");
    const client = new SandboxClient({ socketPath: config.launcherSocket });
    const evidence = await probeSyntheticScience({ client, imageDigest: config.imageDigest });
    console.log(JSON.stringify({ case: "science-image", evidence })); return;
  }
  let rig;
  try {
    rig = await createSandboxRig({ caseName: args[1] });
    console.log(JSON.stringify({ case: args[1], evidence: rig.evidence }));
  } finally {
    await rig?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runProbe(process.argv.slice(2)); }
  catch (error) {
    // Configuration/broker errors may carry secrets; emit only curated messages.
    console.error(error.prerequisite ? error.message : error.reason ? `Sandbox probe failed: ${error.reason}` : "Sandbox probe failed");
    process.exitCode = 1;
  }
}
