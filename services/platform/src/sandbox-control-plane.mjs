import { createHash } from "node:crypto";
import { SandboxNativeJobs } from "./sandbox-native-jobs.mjs";
import { lstat, readFile } from "node:fs/promises";
import { ModelBroker } from "./model-broker.mjs";
import { readManagedModelCatalog } from "./managed-model-catalog.mjs";
import { resolveOpenCodeFreeCatalog } from "./opencode-free-catalog.mjs";
import { EgressBroker } from "./egress-broker.mjs";
import { PackageBroker } from "./package-broker.mjs";
import { SandboxClient } from "./sandbox-client.mjs";
import { ManagedWorkerManager } from "./managed-worker-manager.mjs";
import { TenantPolicy } from "./tenant-policy.mjs";
import { HostAdmission, hostPressure } from "./host-admission.mjs";
import { SandboxScheduler } from "./sandbox-scheduler.mjs";
import { WorkspaceRpc } from "./workspace-rpc.mjs";
import { SandboxEnvironments } from "./sandbox-environments.mjs";
import { PackageGrants } from "./package-grants.mjs";

const routeSet = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
export async function waitManagedRuntime(access, {directory,fetchImpl=fetch,timeoutMs=60000,delayMs=250}={}) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    try {
      const response=await fetchImpl(`${access.url}/session?directory=${encodeURIComponent(directory)}`,{headers:{authorization:`Basic ${Buffer.from(`opencode:${access.token}`).toString("base64")}`},
        signal:AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now())))});
      const body=response.ok ? await response.json() : null;
      if(Array.isArray(body))return;
      await response.body?.cancel();
    }catch{}
    await new Promise(done=>setTimeout(done,Math.min(delayMs,Math.max(0,deadline-Date.now()))));
  }
  throw new Error("managed OpenCode runtime unavailable");
}
export function validateBrokerConfiguration(config) {
  if (!config || config.schema !== 1 || Object.keys(config).some((key) => !["schema", "providers", "defaultProvider", "defaultModel", "mirrorUrl"].includes(key)) ||
      config.mirrorUrl !== "http://127.0.0.1:3141" || !config.providers || Array.isArray(config.providers)) throw new Error("invalid managed broker configuration");
  for (const [name, provider] of Object.entries(config.providers)) {
    let url;
    try { url = new URL(provider.baseUrl); } catch { throw new Error("invalid managed provider configuration"); }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || !["http:","https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search ||
        Object.keys(provider).some((key) => !["baseUrl", "credential", "authMode", "enabledModels", "routes", "catalog", "name", "modelNames", "modelVariants"].includes(key)) ||
        typeof provider.credential !== "string" || !provider.credential || /[\0\r\n]/.test(provider.credential) ||
        !["bearer", "x-api-key"].includes(provider.authMode) || !Array.isArray(provider.enabledModels) || !provider.enabledModels.length ||
        provider.enabledModels.some((model) => typeof model !== "string" || !model || model.length > 160 || /[\0\r\n]/.test(model)) ||
        !Array.isArray(provider.routes) || !provider.routes.length || provider.routes.some((route) => !routeSet.has(route)))
      throw new Error("invalid managed provider configuration");
    if (provider.modelVariants !== undefined && (!provider.modelVariants || typeof provider.modelVariants !== "object" ||
        Array.isArray(provider.modelVariants) || Object.entries(provider.modelVariants).some(([id, levels]) =>
          !provider.enabledModels.includes(id) || !Array.isArray(levels) || !levels.length || levels.length > 7 ||
          new Set(levels).size !== levels.length || levels.some((level) => !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(level)))))
      throw new Error("invalid managed reasoning levels");
    if ((provider.catalog !== undefined && (provider.catalog !== "opencode-free" || name !== "opencode" || provider.baseUrl !== "https://opencode.ai/zen/v1")) ||
        (provider.name !== undefined && (typeof provider.name !== "string" || !provider.name || provider.name.length > 512)) ||
        (provider.modelNames !== undefined && (!provider.modelNames || typeof provider.modelNames !== "object" || Array.isArray(provider.modelNames) ||
          Object.entries(provider.modelNames).some(([id, label]) => !provider.enabledModels.includes(id) || typeof label !== "string" || !label || label.length > 512))))
      throw new Error("invalid managed provider catalog");
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
      whitelist: [...provider.enabledModels],
      models: Object.fromEntries(provider.enabledModels.map((model) => [model, { name: model,
        ...(provider.modelVariants?.[model] ? { reasoning: true,
          variants: Object.fromEntries(provider.modelVariants[model].map((effort) => [effort, { reasoningEffort: effort }])) } : {}),
      }])) },
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
  config = validateBrokerConfiguration(await resolveOpenCodeFreeCatalog(validateBrokerConfiguration(config ?? await readBrokerConfiguration())));
  let environments;
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
  const packageGrants = new PackageGrants();
  const packages = new PackageBroker({ mirrorUrl: config.mirrorUrl, identify,
    authorize: (context, route, token) => packageGrants.authorize(context, route, token) });
  const client = new SandboxClient({ socketPath: configuration.socketPath });
  const admission = new HostAdmission();
  const scheduler = new SandboxScheduler({ pressure: hostPressure, admission: (input) => admission.acquire(input) });
  const manager = new ManagedWorkerManager({ rootDir: `${dataDir}/workers`, imageDigest: configuration.imageDigest, client, tenantPolicy,
    instancesDir: configuration.roots?.instances,
    admitWorker: (context) => scheduler.acquire({ context, kind: "job" }),
    configureWorker: async ({ context, access }) => {
      const address = new URL(access.url).hostname;
      if (accounts.has(address)) throw new Error("sandbox identity collision");
      accounts.set(address, { context });
      const profile = brokerProfile({ config, broker: model, context });
      const token = profile.provider[config.defaultProvider].options.apiKey;
      const response = await fetch(`${access.runnerUrl}/profile`, { method: "POST", headers: {
        authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId: context.instanceId, generation: context.generation, profile, imageDigest:configuration.imageDigest }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("managed profile unavailable");
      await waitManagedRuntime(access,{directory:context.workspaceDir});
      const timer = setInterval(() => {
        try { model.renew(token, context); }
        catch { clearInterval(timer); void manager.stopWorker(context.instanceId).catch(() => {}); }
      }, 300000);
      timer.unref(); accounts.get(address).timer = timer;
    },
    revokeWorker: (context) => {
      scheduler.invalidate(context);
      model.revokeContext(context); egress.revoke(context); packageGrants.revokeContext(context); environments?.revokeContext(context);
      for (const [address, account] of accounts) if (account.context.instanceId === context.instanceId && account.context.generation === context.generation) {
        clearInterval(account.timer); accounts.delete(address);
      }
    },
  });
  try {
    await model.listen(); await packages.listen({ host: "172.31.240.1", port: 4793 }); await egress.listen({ host: "172.31.240.1", port: 4794 });
  } catch { await Promise.allSettled([model.close(), packages.close(), egress.close()]); throw new Error("managed brokers unavailable"); }
  const files = new WorkspaceRpc({ workerManager: manager, tenantPolicy });
  environments = new SandboxEnvironments({ files, tenantPolicy, packageGrants, imageDigest: configuration.imageDigest,
    acquireMaintenance: (context) => manager.acquireMaintenance(context) });
  const nativeJobs=new SandboxNativeJobs({files,workerManager:manager,tenantPolicy});
  const nativeProfileResolver={refresh:async(runtime)=>{
    const provider=config.providers[config.defaultProvider];
    const enabled=Boolean(configuration.enabledRuntimes?.includes(runtime) && runtime==="codex" && provider.authMode==="bearer" && provider.routes.includes("/v1/responses"));
    const revision=createHash("sha256").update(JSON.stringify({image:configuration.imageDigest,provider:config.defaultProvider,
      endpoint:provider.baseUrl,models:provider.enabledModels})).digest("hex");
    return {runtime,identityRevision:revision,catalogRevision:revision,sourceRevision:revision,
      models:enabled?provider.enabledModels.map(id=>({id,name:id,variants:{},inputModalities:["text","image"]})):[],
      defaultModel:enabled?config.defaultModel:null,status:enabled?"ready":"unavailable",enabledByProfile:enabled,files:{}};
  }};
  return { manager, tenantPolicy, model, packages, packageGrants, egress, files, environments, nativeJobs, nativeProfileResolver,
    runtimeCatalog: (context, { access }) => readManagedModelCatalog({ config, context, access }),
    async close() {
      try { await manager.close(); }
      finally { await Promise.allSettled([scheduler.close(), model.close(), packages.close(), egress.close()]); }
    },
  };
}
