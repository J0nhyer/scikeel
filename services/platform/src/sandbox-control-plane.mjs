import { join } from "node:path";
import { SandboxNativeJobs } from "./sandbox-native-jobs.mjs";
import { ManagedCodexProfile } from "./cli-profile.mjs";
import { lstat, readFile } from "node:fs/promises";
import { ModelBroker } from "./model-broker.mjs";
import { readManagedModelCatalog, readManagedDefaultModel, saveManagedDefaultModel } from "./managed-model-catalog.mjs";
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
  if (!config || config.schema !== 1 || Object.keys(config).some((key) => !["schema", "providers", "defaultProvider", "defaultModel", "mirrorUrl", "searchProvider"].includes(key)) ||
      config.mirrorUrl !== "http://127.0.0.1:3141" || !config.providers || Array.isArray(config.providers)) throw new Error("invalid managed broker configuration");
  if (config.searchProvider !== undefined && config.searchProvider !== 'parallel') throw new Error('invalid managed search provider');
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
          !provider.enabledModels.includes(id) || !Array.isArray(levels) || !levels.length || levels.length > 9 ||
          new Set(levels).size !== levels.length || levels.some((level) => !["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "enabled", "disabled"].includes(level)))))
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
export function brokerProfile({ config, broker, context, model, profileRevision, assistantPolicy, now = Date.now() }) {
  validateBrokerConfiguration(config);
  const name = config.defaultProvider; const provider = config.providers[name];
  const scope = assistantPolicy === undefined ? {} : assistantPolicy?.activeRuntime === "opencode" &&
    assistantPolicy.recoveryRequired === false && Number.isSafeInteger(assistantPolicy.revision) && assistantPolicy.revision > 0
    ? { runtime: "opencode", policyRevision: assistantPolicy.revision } : { runtime: "opencode", bridgeOnly: true };
  const token = broker.issue({ ...context, provider: name, models: provider.enabledModels, routes: provider.routes,
    ...scope, ...(profileRevision !== undefined ? { profileRevision } : {}), expiresAt: now + 900000 });
  const selected = provider.enabledModels.some(id => `${name}/${id}` === model) ? model : `${name}/${config.defaultModel}`;
  return { ...(config.searchProvider ? { searchProvider: config.searchProvider } : {}), model: selected, enabled_providers: [name], provider: {
    [name]: { npm: provider.authMode === "x-api-key" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible", name,
      options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: token },
      whitelist: [...provider.enabledModels],
      models: Object.fromEntries(provider.enabledModels.map((model) => [model, { name: model,
        ...(provider.modelVariants?.[model] ? { reasoning: true,
          variants: Object.fromEntries(provider.modelVariants[model].map((effort) => [effort, ["enabled", "disabled"].includes(effort) ? { thinking: { type: effort } } : { reasoningEffort: effort }])) } : {}),
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
export function managedNativeProfileResolver({ configuration, serviceProfile, broker }) {
  let revision = null, registered = false, pending = Promise.resolve();
  const unavailable = runtime => ({ runtime, status: "unavailable", enabledByProfile: false,
    models: [], defaultModel: null, catalogRevision: null });
  const revoke = () => { if (registered) broker.revokeProvider("scikeel-codex"); registered = false; };
  const read = async runtime => {
    if (!["codex", "claude"].includes(runtime)) throw Object.assign(new Error("invalid_runtime"), { code: "invalid_runtime" });
    if (runtime !== "codex") return unavailable(runtime);
    if (!configuration.enabledRuntimes?.includes("codex")) { revoke(); return unavailable(runtime); }
    try {
      const profile = await serviceProfile.refresh("codex");
      if (profile.status !== "ready") { revoke(); return unavailable(runtime); }
      if (!registered || revision !== profile.identityRevision) {
        const provider = await serviceProfile.resolveProvider(profile.identityRevision);
        broker.replaceProviderSnapshot({ name: "scikeel-codex", expectedRevision: revision,
          identityRevision: profile.identityRevision, provider, createOnly: revision === null });
        revision = profile.identityRevision; registered = true;
      }
      return profile;
    } catch (error) { revoke(); throw error; }
  };
  const serial=run=>{const next=pending.catch(()=>{}).then(run);pending=next;return next;};
  return {
    refresh:runtime=>serial(()=>read(runtime)),
    issueNativeGrant(input) {
      const captured=structuredClone(input);
      return serial(async()=>{
        const denied=()=>Object.assign(new Error('native_model_grant_denied'),{code:'native_model_grant_denied',statusCode:503});
        if(!captured||Object.keys(captured).some(key=>!['context','turnIdentity','model','variant','identityRevision'].includes(key))||
            !captured.context||captured.turnIdentity?.runtime!=='codex')throw denied();
        const profile=await read('codex'),selected=profile.models.find(model=>model.id===captured.model);
        if(profile.status!=='ready'||profile.identityRevision!==captured.identityRevision||!selected||
            captured.variant!=null&&(typeof captured.variant!=='string'||!Object.hasOwn(selected.variants,captured.variant)))throw denied();
        const context=Object.fromEntries(['userId','instanceId','generation'].map(field=>[field,captured.context[field]]));
        const token=broker.issue({...context,runtime:'codex',policyRevision:captured.turnIdentity.policyRevision,
          turnIdentity:captured.turnIdentity,provider:'scikeel-codex',profileRevision:profile.identityRevision,
          models:[selected.id],routes:['/v1/responses'],expiresAt:Date.now()+900000});
        const configuration=Object.freeze({model:selected.id,modelToken:token,modelUrl:'http://172.31.240.1:4792/v1',
          ...(captured.variant!=null?{effort:selected.variants[captured.variant].reasoningEffort}:{})});
        return Object.freeze({identityRevision:profile.identityRevision,configuration,
          renew:()=>broker.renew(token,context),revoke:()=>broker.revokeAndDrain(token)});
      });
    },
  };
}
export async function createSandboxControlPlane({ configuration, dataDir, config }) {
  config = validateBrokerConfiguration(await resolveOpenCodeFreeCatalog(validateBrokerConfiguration(config ?? await readBrokerConfiguration())));
  let environments; let plane;
  const accounts = new Map(); const tenantPolicy = new TenantPolicy();
  const identify = (input) => {
    const address = typeof input === "string" ? input : input.socket?.remoteAddress;
    const normalized = address?.startsWith("::ffff:") ? address.slice(7) : address;
    const account = accounts.get(normalized);
    if (!account) throw new Error("unknown sandbox identity");
    return account.context;
  };
  const model = new ModelBroker({ providers: config.providers, identify,
    assistantPolicy: context => plane?.assistantPolicy?.(context),executionAuthority:identity=>plane?.executionAuthority?.(identity)===true });
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
      const savedModel = await readManagedDefaultModel({ root: `${dataDir}/model-defaults`, userId: context.userId });
      const profile = brokerProfile({ config, broker: model, context, model: savedModel,
        assistantPolicy: plane?.assistantPolicy?.(context) ?? null });
      const token = profile.provider[config.defaultProvider].options.apiKey;
      const response = await fetch(`${access.runnerUrl}/profile`, { method: "POST", headers: {
        authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ instanceId: context.instanceId, generation: context.generation, profile, imageDigest:configuration.imageDigest }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("managed profile unavailable");
      await waitManagedRuntime(access,{directory:context.workspaceDir});
      const timer = setInterval(() => {
        try { model.renew(token, context); }
        catch { clearInterval(timer); void manager.stopWorker(context.instanceId, {expectedGeneration:context.generation}).catch(() => {}); }
      }, 300000);
      timer.unref(); accounts.get(address).timer = timer;
    },
    revokeWorker: async (context) => {
      scheduler.invalidate(context);
      model.revokeContext(context); egress.revoke(context); packageGrants.revokeContext(context); environments?.revokeContext(context);
      for (const [address, account] of accounts) if (account.context.instanceId === context.instanceId && account.context.generation === context.generation) {
        clearInterval(account.timer); accounts.delete(address);
      }
      // Diagnostic persistence must not prevent revocation of broker authority.
      await plane?.revokeNetwork?.(context);
    },
  });
  try {
    await model.listen(); await packages.listen({ host: "172.31.240.1", port: 4793 }); await egress.listen({ host: "172.31.240.1", port: 4794 });
  } catch { await Promise.allSettled([model.close(), packages.close(), egress.close()]); throw new Error("managed brokers unavailable"); }
  const files = new WorkspaceRpc({ workerManager: manager, tenantPolicy });
  environments = new SandboxEnvironments({ files, tenantPolicy, packageGrants, imageDigest: configuration.imageDigest,
    acquireMaintenance: (context) => manager.acquireMaintenance(context) });
  const nativeProfileResolver = managedNativeProfileResolver({ configuration, broker: model,
    serviceProfile: new ManagedCodexProfile({ home: join(dataDir, "codex-service") }) });
  const nativeJobs=new SandboxNativeJobs({files,workerManager:manager,tenantPolicy,
    issueNativeGrant:input=>nativeProfileResolver.issueNativeGrant(input)});
  manager.inspectNative = context => nativeJobs.inspect(context);
  plane = { manager, tenantPolicy, model, packages, packageGrants, egress, files, environments, searchProvider: config.searchProvider, nativeJobs, nativeProfileResolver,
    runtimeCatalog: (context, { access }) => readManagedModelCatalog({ config, context, access }),
    saveRuntimeDefaultModel: (context, model) => saveManagedDefaultModel({ root: `${dataDir}/model-defaults`, userId: context.userId, model }),
    async close() {
      try { await manager.close(); }
      finally { await Promise.allSettled([scheduler.close(), model.close(), packages.close(), egress.close()]); }
    },
  };
  return plane;
}
