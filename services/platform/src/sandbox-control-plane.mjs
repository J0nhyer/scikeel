import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { SandboxNativeJobs } from "./sandbox-native-jobs.mjs";
import { ManagedCodexProfile } from "./cli-profile.mjs";
import { lstat, readFile } from "node:fs/promises";
import { ModelBroker } from "./model-broker.mjs";
import { createManagedModelCatalogReader, readManagedDefaultModel, saveManagedDefaultModel } from "./managed-model-catalog.mjs";
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
import {capacityError} from './workspace-capacity.mjs';

const routeSet = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
const brokerHostPattern = /^[A-Za-z0-9.-]{1,253}$/;
const workerHostPattern = /^[A-Za-z0-9._-]{1,253}$/;
export async function resolveWorkerAliases(hostname, lookupImpl = lookup) {
  if (typeof hostname !== "string" || !workerHostPattern.test(hostname)) throw new Error("invalid worker hostname");
  let resolved;
  try { resolved = await lookupImpl(hostname, { all: true, verbatim: true }); }
  catch { throw new Error("worker identity unavailable"); }
  if (!Array.isArray(resolved) || resolved.length === 0) throw new Error("worker identity unavailable");
  const aliases = [hostname];
  for (const entry of resolved) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (typeof address !== "string" || !address) throw new Error("worker identity unavailable");
    if (!aliases.includes(address)) aliases.push(address);
  }
  return aliases;
}
export async function waitManagedRuntime(access, {directory,runtime='opencode',fetchImpl=fetch,timeoutMs=60000,delayMs=250}={}) {
  if(!['opencode','codex','claude'].includes(runtime))throw new Error('invalid managed runtime');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    try {
      const path=runtime==='opencode'?`/session?directory=${encodeURIComponent(directory)}`:'/v1/whoami';
      const response=await fetchImpl(`${access.url}${path}`,{headers:{authorization:runtime==='opencode'?`Basic ${Buffer.from(`opencode:${access.token}`).toString("base64")}`:`Bearer ${access.token}`},
        signal:AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now())))});
      const body=response.ok ? await response.json() : null;
      if(runtime==='opencode'?Array.isArray(body):body?.directory===directory)return;
      await response.body?.cancel();
    }catch{}
    await new Promise(done=>setTimeout(done,Math.min(delayMs,Math.max(0,deadline-Date.now()))));
  }
  throw new Error("managed OpenCode runtime unavailable");
}
/** The tenant runner announces the runtime protocol it understands. A runner
 *  from an older image answers 404 and keeps the previous contract: it selects
 *  the runtime itself and readiness follows its own endpoint. */
export async function runnerProtocol(access,{fetchImpl=fetch,timeoutMs=3000}={}){
 const response=await fetchImpl(`${access.runnerUrl}/readiness`,{headers:{authorization:`Bearer ${access.token}`},signal:AbortSignal.timeout(timeoutMs)}).catch(()=>null);
 if(!response)return {runtime:false};
 await response.body?.cancel();
 return {runtime:response.status!==404};
}
export function validateBrokerConfiguration(config) {
  if (!config || config.schema !== 1 || Object.keys(config).some((key) => !["schema", "providers", "defaultProvider", "defaultModel", "mirrorUrl", "searchProvider"].includes(key)) ||
      !["http://127.0.0.1:3141", "http://package-mirror:3141"].includes(config.mirrorUrl) ||
      !config.providers || Array.isArray(config.providers)) throw new Error("invalid managed broker configuration");
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
export function brokerProfile({ config, broker, context, model, profileRevision, assistantPolicy, brokerHost = "172.31.240.1", now = Date.now() }) {
  validateBrokerConfiguration(config);
  if (!brokerHostPattern.test(brokerHost)) throw new Error("invalid managed broker host");
  const name = config.defaultProvider; const provider = config.providers[name];
  const scope = assistantPolicy === undefined ? {} : assistantPolicy?.activeRuntime === "opencode" &&
    assistantPolicy.recoveryRequired === false && Number.isSafeInteger(assistantPolicy.revision) && assistantPolicy.revision > 0
    ? { runtime: "opencode", policyRevision: assistantPolicy.revision } : { runtime: "opencode", bridgeOnly: true };
  const token = broker.issue({ ...context, provider: name, models: provider.enabledModels, routes: provider.routes,
    ...scope, ...(profileRevision !== undefined ? { profileRevision } : {}), expiresAt: now + 900000 });
  const selected = provider.enabledModels.some(id => `${name}/${id}` === model) ? model : `${name}/${config.defaultModel}`;
  return { ...(config.searchProvider ? { searchProvider: config.searchProvider } : {}), model: selected, enabled_providers: [name], provider: {
    [name]: { npm: provider.authMode === "x-api-key" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible", name,
      options: { baseURL: `http://${brokerHost}:4792/v1`, apiKey: token },
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
  // The systemd platform reads a root-owned seal; the containerized platform
  // runs as the live data owner and receives a 0600 bind mount owned by it.
  const owner = process.getuid?.();
  if (!metadata.isFile() || (metadata.uid !== 0 && metadata.uid !== owner) || (metadata.mode & 0o022) || metadata.size > 65536)
    throw new Error("untrusted managed broker configuration");
  try { return validateBrokerConfiguration(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new Error("managed broker configuration unavailable"); }
}
export function managedNativeProfileResolver({ configuration, serviceProfile, broker, brokerHost = "172.31.240.1" }) {
  if (!brokerHostPattern.test(brokerHost)) throw new Error("invalid managed broker host");
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
        const configuration=Object.freeze({model:selected.id,modelToken:token,modelUrl:`http://${brokerHost}:4792/v1`,
          ...(captured.variant!=null?{effort:selected.variants[captured.variant].reasoningEffort}:{})});
        return Object.freeze({identityRevision:profile.identityRevision,configuration,
          renew:()=>broker.renew(token,context),revoke:()=>broker.revokeAndDrain(token)});
      });
    },
  };
}
export function validateCapacity({ maxResidents = 1 } = {}) {
  if (!Number.isSafeInteger(maxResidents) || maxResidents < 1 || maxResidents > 2)
    throw new Error("invalid managed capacity configuration");
  return { maxResidents };
}
export async function createSandboxControlPlane({ configuration, dataDir, config, logger = () => {}, capacity = {} }) {
  const { maxResidents } = validateCapacity(capacity);
  config = validateBrokerConfiguration(await resolveOpenCodeFreeCatalog(validateBrokerConfiguration(config ?? await readBrokerConfiguration())));
  const brokerHost = configuration.brokerHost ?? "172.31.240.1";
  const dockerMode = configuration.backend === "docker";
  const brokerListenHost = dockerMode ? "0.0.0.0" : "172.31.240.1";
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
  const client = new SandboxClient({ socketPath: configuration.socketPath, workerPrefix: configuration.workerPrefix ?? null });
  const admission = new HostAdmission({ mode: dockerMode ? "docker" : "legacy" });
  const pressure = () => hostPressure({ mode: dockerMode ? "docker" : "legacy" });
  const scheduler = new SandboxScheduler({maxSandboxes:maxResidents,maxJobs:1,pressure,admission:input=>admission.acquire({...input,shared:true})});
  const manager = new ManagedWorkerManager({ rootDir: `${dataDir}/workers`, imageDigest: configuration.imageDigest, client, tenantPolicy,
    logger,
    instancesDir: configuration.roots?.instances,
    maxResidents,
    admitWorker: async () => {
      const observed=await pressure();
      if(observed.availableBytes<600*1024**2)throw capacityError('memory_reserve');
      return admission.acquire({shared:true});
    },
    configureWorker: async ({ context, access }) => {
      const hostname = new URL(access.url).hostname;
      const aliases = await resolveWorkerAliases(hostname);
      for (const alias of aliases) if (accounts.has(alias)) throw new Error("sandbox identity collision");
      const identity = { context };
      for (const alias of aliases) accounts.set(alias, identity);
      const savedModel = await readManagedDefaultModel({ root: `${dataDir}/model-defaults`, userId: context.userId });
      const runtime=plane?.assistantPolicy?.(context)?.activeRuntime??'opencode';
      const profile = brokerProfile({ config, broker: model, context, model: savedModel, brokerHost,
        assistantPolicy: plane?.assistantPolicy?.(context) ?? null });
      const token = profile.provider[config.defaultProvider].options.apiKey;
      // The tenant runner announces the runtime protocol it understands. An
      // installed image without it keeps the previous contract: the runner
      // selects the runtime itself and readiness follows its own endpoint.
      const profileStarted = performance.now();
      let protocol;
      try {
        protocol=await runnerProtocol(access);
        const response = await fetch(`${access.runnerUrl}/profile`, { method: "POST", headers: {
          authorization: `Bearer ${access.token}`, "content-type": "application/json" },
          body: JSON.stringify({ instanceId: context.instanceId, generation: context.generation, profile, imageDigest:configuration.imageDigest,
            ...(protocol.runtime?{runtime}:{}) }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("managed profile unavailable");
      } finally {
        logger({ type: "workspace.startup_stage", stage: "profile", generation: context.generation, elapsedMs: Math.round(performance.now() - profileStarted) });
      }
      const readinessStarted = performance.now();
      try {
        await waitManagedRuntime(access,{directory:context.workspaceDir,...(protocol.runtime?{runtime}:{})});
        if(protocol.runtime){
          const readiness=await fetch(`${access.runnerUrl}/readiness`,{headers:{authorization:`Bearer ${access.token}`},signal:AbortSignal.timeout(3000)});
          const report=await readiness.json();
          if(!readiness.ok||report.runtime!==runtime||report.configured!==true||report.gatewayReady!==true||runtime!=='opencode'&&report.jobsReady!==true)throw Error('managed runner unavailable');
        }
      } finally {
        logger({ type: "workspace.startup_stage", stage: "readiness", generation: context.generation, elapsedMs: Math.round(performance.now() - readinessStarted) });
      }
      const timer = setInterval(() => {
        try { model.renew(token, context); }
        catch { clearInterval(timer); void manager.stopWorker(context.instanceId, {expectedGeneration:context.generation}).catch(() => {}); }
      }, 300000);
      timer.unref(); identity.timer = timer;
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
    await model.listen({ host: brokerListenHost }); await packages.listen({ host: brokerListenHost, port: 4793 });
    await egress.listen({ host: brokerListenHost, port: 4794 });
  } catch { await Promise.allSettled([model.close(), packages.close(), egress.close()]); throw new Error("managed brokers unavailable"); }
  const files = new WorkspaceRpc({ workerManager: manager, tenantPolicy, workerPrefix: configuration.workerPrefix ?? null });
  environments = new SandboxEnvironments({ files, tenantPolicy, packageGrants, imageDigest: configuration.imageDigest,
    acquireMaintenance: (context) => manager.acquireMaintenance(context) });
  const nativeProfileResolver = managedNativeProfileResolver({ configuration, broker: model, brokerHost,
    serviceProfile: new ManagedCodexProfile({ home: join(dataDir, "codex-service") }) });
  const nativeJobs=new SandboxNativeJobs({files,workerManager:manager,tenantPolicy,
    issueNativeGrant:input=>nativeProfileResolver.issueNativeGrant(input)});
  nativeJobs.admitJob=(context,signal)=>scheduler.acquire({context,kind:'job',signal});
  manager.inspectNative = context => nativeJobs.inspect(context);
  manager.runtimeForContext = context => plane?.assistantPolicy?.(context)?.activeRuntime??"opencode";
  plane = { manager, tenantPolicy, model, packages, packageGrants, egress, files, environments, searchProvider: config.searchProvider, nativeJobs, nativeProfileResolver,
    capacity: { maxResidents },
    analyticsRegistry:{providers:new Set(Object.keys(config.providers)),models:new Set(Object.values(config.providers).flatMap(p=>p.enabledModels)),skills:new Set(['research-workflow'])},
    runtimeCatalog: createManagedModelCatalogReader({config}),
    saveRuntimeDefaultModel: (context, model) => saveManagedDefaultModel({ root: `${dataDir}/model-defaults`, userId: context.userId, model }),
    async close() {
      try { await manager.close(); }
      finally { await Promise.allSettled([scheduler.close(), model.close(), packages.close(), egress.close()]); }
    },
  };
  return plane;
}
