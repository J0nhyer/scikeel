import { lstat, readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const acceptanceRoot = join(root, ".deploy/tenant-sandbox-acceptance");

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

async function loadConfig(path) {
  let metadata;
  try { metadata = await lstat(path); }
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
  process.env.OSD_SANDBOX_TEST_CONFIG ?? "/etc/scikeel/sandbox-test.json" }) {
  if (caseName !== "preflight") throw prerequisite("unsupported case");
  const config = await loadConfig(configPath);
  let client;
  try {
    // No fake success when the production launcher interface is not available.
    const { SandboxClient } = await import("../src/sandbox-client.mjs");
    client = new SandboxClient({ socketPath: config.launcherSocket });
  } catch { throw prerequisite("configured sandbox launcher client is unavailable"); }
  let capabilities;
  try { capabilities = await client.preflight({ synthetic: true }); }
  catch { throw prerequisite("configured sandbox launcher is unavailable"); }
  if (capabilities?.schema !== 1 || capabilities.synthetic !== true ||
      capabilities.controllers?.some((value) => !["memory", "pids", "cpu"].includes(value)) ||
      !["memory", "pids", "cpu"].every((value) => capabilities.controllers?.includes(value)) ||
      capabilities.quota?.enforced !== true || capabilities.quota?.bytes !== 2147483648 ||
      capabilities.quota?.inodes !== 100000 || capabilities.imageDigest !== config.imageDigest)
    throw prerequisite("verified controllers, image and disk/inode quotas are required");
  const generation = randomUUID();
  await mkdir(acceptanceRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(acceptanceRoot, "case-"));
  const marker = join(temporary, "generation");
  const started = [];
  let closed = false;
  async function close() {
    if (closed) return;
    // Stop only explicitly registered, generation-matching synthetic instances.
    for (const context of started) await client.stop({ instanceId: context.instanceId,
      generation: context.generation, reason: "synthetic-cleanup" });
    if ((await readFile(marker, "utf8")) !== generation)
      throw prerequisite("cleanup generation changed; refusing to remove files");
    if (dirname(temporary) !== acceptanceRoot)
      throw prerequisite("refusing cleanup outside synthetic root");
    await rm(temporary, { recursive: true });
    closed = true;
  }
  try {
    await writeFile(marker, generation, { mode: 0o600 });
    const contexts = [];
    for (const label of ["a", "b"]) {
      const instanceId = `sandbox-test-${generation}-${label}`;
      const userId = `sandbox-test-${generation}-${label}`;
      const owned = join(temporary, label);
      await mkdir(owned, { mode: 0o700 });
      await writeFile(join(owned, "canary.txt"), `synthetic-${randomUUID()}`, { mode: 0o600 });
      const registered = await client.register({ instanceId, userId });
      const context = { userId, instanceId, generation: registered.generation };
      if (registered.instanceId !== instanceId || !Number.isSafeInteger(context.generation))
        throw prerequisite("launcher registration did not match synthetic account");
      contexts.push(context);
      started.push(context);
    }
    const { WorkspaceRpc } = await import("../src/workspace-rpc.mjs");
    const { createTestBrokers } = await import("./sandbox-brokers.mjs");
    return { a: contexts[0], b: contexts[1], client,
      files: new WorkspaceRpc({ client }), brokers: await createTestBrokers(config), close,
      evidence: { synthetic: true, controllers: capabilities.controllers,
        quota: capabilities.quota, imageDigest: config.imageDigest } };
  } catch (error) {
    await close();
    if (error.prerequisite) throw error;
    throw prerequisite("configured file and broker interfaces are unavailable");
  }
}
