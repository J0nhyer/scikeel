import { lstat, readFile } from "node:fs/promises";
import { ModelBroker } from "./model-broker.mjs";
import { EgressBroker } from "./egress-broker.mjs";
import { PackageBroker } from "./package-broker.mjs";
import { SandboxClient } from "./sandbox-client.mjs";
import { ManagedWorkerManager } from "./managed-worker-manager.mjs";
import { TenantPolicy } from "./tenant-policy.mjs";
import { HostAdmission, hostPressure } from "./host-admission.mjs";
import { SandboxScheduler } from "./sandbox-scheduler.mjs";
import { WorkspaceRpc } from "./workspace-rpc.mjs";

const routeSet = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
export function validateBrokerConfiguration(config) {
  if (!config || config.schema !== 1 || Object.keys(config).some((key) => !["schema", "providers", "defaultProvider", "defaultModel", "mirrorUrl"].includes(key)) ||
      config.mirrorUrl !== "http://127.0.0.1:3141" || !config.providers || Array.isArray(config.providers)) throw new Error("invalid managed broker configuration");
  for (const [name, provider] of Object.entries(config.providers)) {
    let url;
    try { url = new URL(provider.baseUrl); } catch { throw new Error("invalid managed provider configuration"); }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
        Object.keys(provider).some((key) => !["baseUrl", "credential", "authMode", "enabledModels", "routes"].includes(key)) ||
        typeof provider.credential !== "string" || !provider.credential || /[\0\r\n]/.test(provider.credential) ||
        !["bearer", "x-api-key"].includes(provider.authMode) || !Array.isArray(provider.enabledModels) || !provider.enabledModels.length ||
        provider.enabledModels.some((model) => typeof model !== "string" || !model || model.length > 160 || /[\0\r\n]/.test(model)) ||
        !Array.isArray(provider.routes) || !provider.routes.length || provider.routes.some((route) => !routeSet.has(route)))
      throw new Error("invalid managed provider configuration");
  }
  if (!config.providers[config.defaultProvider]?.enabledModels.includes(config.defaultModel)) throw new Error("invalid managed default model");
  return config;
}
export function brokerProfile({ config, broker, context, now = Date.now() }) {
  validateBrokerConfiguration(config);
  const name = config.defaultProvider; const provider = config.providers[name];
  const token = broker.issue({ ...context, provider: name, models: provider.enabledModels, routes: provider.routes, expiresAt: now + 900000 });
  return { model: `${name}/${config.defaultModel}`, enabled_providers: [name], provider: {
    [name]: { npm: provider.authMode === "x-api-key" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible", name,
      options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: token },
      models: Object.fromEntries(provider.enabledModels.map((model) => [model, { name: model }])) },
  }, permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" } };
}
export async function readBrokerConfiguration() {
  const path = "/etc/scikeel/model-brokers.json";
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 65536) throw new Error("untrusted managed broker configuration");
  try { return validateBrokerConfiguration(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new Error("managed broker configuration unavailable"); }
}
export async function createSandboxControlPlane({ configuration, dataDir, config }) {
  config = validateBrokerConfiguration(config ?? await readBrokerConfiguration());
  const accounts = new Map(); const tenantPolicy = new TenantPolicy();
  const identify = (input) => {
    const address = typeof input === "string" ? input : input.socket?.remoteAddress;
    const normalized = address?.startsWith("::ffff:") ? address.slice(7) : address;
    const account = accounts.get(normalized);
    if (!account) throw new Error("unknown sandbox identity");
    return account.context;
  };
  const model = new ModelBroker({ providers: config.providers, identify });
  const egress = new EgressBroker({ identify });
  const packages = new PackageBroker({ mirrorUrl: config.mirrorUrl, identify,
    // Package access is issued only by the approved-install integration.
    authorize: () => false });
  const client = new SandboxClient({ socketPath: configuration.socketPath });
  const admission = new HostAdmission();
  const scheduler = new SandboxScheduler({ pressure: hostPressure, admission: (input) => admission.acquire(input) });
  const manager = new ManagedWorkerManager({ rootDir: `${dataDir}/workers`, imageDigest: configuration.imageDigest, client, tenantPolicy,
    admitWorker: (context) => scheduler.acquire({ context, kind: "job" }),
    configureWorker: async ({ context, access }) => {
      const address = new URL(access.url).hostname;
      if (accounts.has(address)) throw new Error("sandbox identity collision");
      accounts.set(address, { context });
      const profile = brokerProfile({ config, broker: model, context });
      const token = profile.provider[config.defaultProvider].options.apiKey;
      const response = await fetch(`${access.runnerUrl}/profile`, { method: "POST", headers: {
        authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId: context.instanceId, generation: context.generation, profile }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("managed profile unavailable");
      const timer = setInterval(() => {
        try { model.renew(token, context); }
        catch { clearInterval(timer); void manager.stopWorker(context.instanceId).catch(() => {}); }
      }, 300000);
      timer.unref(); accounts.get(address).timer = timer;
    },
    revokeWorker: (context) => {
      scheduler.invalidate(context);
      model.revokeContext(context); egress.revoke(context);
      for (const [address, account] of accounts) if (account.context.instanceId === context.instanceId && account.context.generation === context.generation) {
        clearInterval(account.timer); accounts.delete(address);
      }
    },
  });
  try {
    await model.listen(); await packages.listen({ host: "172.31.240.1", port: 4793 }); await egress.listen({ host: "172.31.240.1", port: 4794 });
  } catch { await Promise.allSettled([model.close(), packages.close(), egress.close()]); throw new Error("managed brokers unavailable"); }
  return { manager, tenantPolicy, model, packages, egress, files: new WorkspaceRpc({ workerManager: manager, tenantPolicy }),
    runtimeCatalog: () => ({ model: `${config.defaultProvider}/${config.defaultModel}`, providers: Object.entries(config.providers).map(([id, value]) => ({
      id, name: id, models: Object.fromEntries(value.enabledModels.map((model) => [model, { id: model, name: model, providerID: id }])) })),
      connected: Object.keys(config.providers), defaults: Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, value.enabledModels[0]])) }),
    async close() {
      try { await manager.close(); }
      finally { await Promise.allSettled([scheduler.close(), model.close(), packages.close(), egress.close()]); }
    },
  };
}
