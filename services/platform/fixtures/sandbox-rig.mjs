import { lstat, readFile } from "node:fs/promises";

function prerequisite(message) {
  return Object.assign(new Error(`Sandbox prerequisite: ${message}`), { prerequisite: true });
}

export function validateTestConfig(config) {
  if (!config || config.schema !== 1 || config.synthetic !== true ||
      config.accountPrefix !== "sandbox-test-" ||
      typeof config.launcherSocket !== "string" || !config.launcherSocket.startsWith("/") ||
      !/^sha256:[a-f0-9]{64}$/.test(config.imageDigest ?? ""))
    throw prerequisite("invalid synthetic configuration");
  // Test configuration contains service locations, never provider credentials.
  const visit = (value) => {
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (/password|secret|token|api.?key|credential|authorization/i.test(key))
        throw prerequisite("credentials cannot be supplied in test configuration");
      visit(item);
    }
  };
  visit(config);
  return config;
}

async function loadConfig(path, inspectConfig = lstat) {
  let metadata;
  try { metadata = await inspectConfig(path); }
  catch { throw prerequisite("root-owned synthetic configuration is missing"); }
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 65536)
    throw prerequisite("configuration must be a bounded root-owned regular file without shared write access");
  try { return validateTestConfig(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error.prerequisite) throw error;
    throw prerequisite("invalid synthetic configuration");
  }
}

export async function createSandboxRig({ caseName, configPath =
  process.env.OSD_SANDBOX_TEST_CONFIG ?? "/etc/scikeel/sandbox-test.json", client: suppliedClient, inspectConfig = lstat }) {
  if (caseName !== "preflight") throw prerequisite("unsupported case");
  const config = await loadConfig(configPath, inspectConfig);
  const { SandboxClient } = await import("../src/sandbox-client.mjs");
  const client = suppliedClient ?? new SandboxClient({ socketPath: config.launcherSocket });
  const started = []; const tenants = [];
  let closed = false;
  async function close() {
    if (closed) return;
    const failures = [];
    for (const context of started.splice(0)) {
      try { await client.stop({ instanceId: context.instanceId, generation: context.generation, reason: "synthetic-cleanup" }); }
      catch { failures.push(context); }
    }
    if (failures.length) { started.push(...failures); throw prerequisite("sandbox cleanup unverified"); }
    closed = true;
  }
  try {
    for (const suffix of ["a", "b"]) {
      const instanceId = `sandbox-test-${suffix}`;
      const registered = await client.register({ instanceId, userId: instanceId });
      const context = { userId: instanceId, instanceId, generation: registered.generation };
      if (registered.instanceId !== instanceId || !Number.isSafeInteger(context.generation) || context.generation < 1)
        throw prerequisite("launcher registration did not match synthetic account");
      started.push(context);
      await client.start({ instanceId, generation: context.generation, imageDigest: config.imageDigest });
      const inspected = await client.inspect({ instanceId });
      const limits = inspected.limits; const quota = inspected.quota;
      if (inspected.status !== "ready" || inspected.generation !== context.generation || inspected.imageDigest !== config.imageDigest ||
          limits?.memoryMax !== 1073741824 || limits.swapMax !== 134217728 || limits.pidsMax !== 256 ||
          limits.cpuQuota !== 100000 || limits.cpuPeriod !== 100000 || limits.owned !== true ||
          quota?.enforced !== true || !Number.isSafeInteger(quota.byteLimit) || quota.byteLimit < 67108864 ||
          !Number.isSafeInteger(quota.inodeLimit) || quota.inodeLimit < 1024)
        throw prerequisite("verified process controllers, image and disk/inode quotas are required");
      tenants.push({ instanceId, generation: context.generation, imageDigest: inspected.imageDigest, limits, quota });
      await client.stop({ instanceId, generation: context.generation, reason: "synthetic-preflight-complete" });
      started.pop();
    }
    return { client, close, evidence: { synthetic: true, tenants, sharedImage: config.imageDigest } };
  } catch (error) {
    await close();
    if (error.prerequisite) throw error;
    throw prerequisite("configured sandbox launcher is unavailable");
  }
}
