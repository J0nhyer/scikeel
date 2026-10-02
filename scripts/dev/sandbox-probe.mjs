import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createSandboxRig } from "../../services/platform/fixtures/sandbox-rig.mjs";

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
    console.error(error.prerequisite ? error.message : "Sandbox probe failed");
    process.exitCode = 1;
  }
}
