import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validModel = (value) => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\r\n\0]/.test(value);
const unique = (items) => [...new Map(items.filter((item) => validModel(item.id)).map((item) => [item.id, item])).values()];
const sourcePath = (home, path) => path?.startsWith("~/.codex/")
  ? join(home, path.slice("~/.codex/".length))
  : path?.startsWith("~/") ? join(dirname(home), path.slice(2))
    : isAbsolute(path ?? "") ? path : join(home, path ?? "");

function codexVariants(entry) {
  const levels = Array.isArray(entry?.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  return Object.fromEntries(levels
    .filter((level) => typeof level?.effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(level.effort))
    .map(({ effort }) => [effort, { reasoningEffort: effort }]));
}

export class CliProfileResolver {
  constructor({ claudeConfigDir = join(homedir(), ".claude"), codexHome = join(homedir(), ".codex"), fetchImpl = globalThis.fetch, clock = Date.now, revisionKey } = {}) {
    this.claudeConfigDir = resolve(claudeConfigDir);
    this.codexHome = resolve(codexHome);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.cached = new Map();
    this.pending = new Map();
    this.revisionKey = revisionKey ?? randomBytes(32);
  }

  async refresh(runtime, { forceRemote = false } = {}) {
    if (this.pending.has(runtime)) return this.pending.get(runtime);
    const task = this.#read(runtime, forceRemote).finally(() => this.pending.delete(runtime));
    this.pending.set(runtime, task);
    return task;
  }

  async #read(runtime, forceRemote) {
    if (runtime !== "claude" && runtime !== "codex") throw new Error("unknown CLI profile");
    try {
      const home = runtime === "claude" ? this.claudeConfigDir : this.codexHome;
      const main = join(home, runtime === "claude" ? "settings.json" : "config.toml");
      const content = await fs.readFile(main, "utf8");
      const config = runtime === "claude" ? JSON.parse(content) : parse(content);
      const env = runtime === "claude" ? config.env ?? {} : {};
      const providerName = runtime === "codex" ? config.model_provider ?? "openai" : "anthropic";
      const provider = runtime === "codex" ? config.model_providers?.[providerName] ?? {} : {};
      const baseUrl = runtime === "claude" ? env.ANTHROPIC_BASE_URL : provider.base_url;
      const envKey = runtime === "codex" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.env_key ?? "") ? provider.env_key : null;
      const token = runtime === "claude" ? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY : envKey ? process.env[envKey] : undefined;
      const authPath = runtime === "codex" ? join(home, "auth.json") : null;
      const auth = authPath ? await fs.readFile(authPath, "utf8").catch(() => "") : "";
      const identityRevision = createHmac("sha256", this.revisionKey).update(JSON.stringify([providerName, baseUrl?.replace(/\/+$/, ""), token, auth, provider.wire_api])).digest("hex");
      const alias = { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL };
      const configuredModel = runtime === "claude" ? env.ANTHROPIC_MODEL ?? config.model : config.model;
      const defaultModel = alias[configuredModel] ?? configuredModel ?? null;
      const catalogPath = runtime === "codex" && config.model_catalog_json ? sourcePath(home, config.model_catalog_json) : null;
      const catalogContent = catalogPath ? await fs.readFile(catalogPath, "utf8") : "";
      const catalog = catalogContent ? JSON.parse(catalogContent) : null;
      const local = unique([
        ...(Array.isArray(catalog) ? catalog : Array.isArray(catalog?.models) ? catalog.models : []).map((entry) => typeof entry === "string" ? { id: entry, name: entry, variants: {} } : { id: entry.slug ?? entry.id, name: entry.display_name ?? entry.name ?? entry.slug, variants: codexVariants(entry), ...(Array.isArray(entry.input_modalities) ? { inputModalities: entry.input_modalities.filter((value) => typeof value === "string") } : {}) }),
      ]);
      const files = { main, content, catalogPath, catalogContent, authPath, auth, home, token, baseUrl, envKey, secrets: runtime === "claude"
        ? Object.entries(env).filter(([key, value]) => /(?:TOKEN|API_KEY|SECRET|PASSWORD)/i.test(key) && typeof value === "string").map(([, value]) => value)
        : [] };
      const sourceRevision = createHmac("sha256", this.revisionKey).update(JSON.stringify([content, catalogContent, auth, token, catalogPath])).digest("hex");
      const previous = this.cached.get(runtime);
      let remote = previous?.identityRevision === identityRevision && this.clock() - previous.checkedAt < 60_000 && !forceRemote ? previous.remote : null;
      let checkedAt = previous?.checkedAt ?? this.clock();
      if (remote === null && baseUrl && runtime === "claude") {
        checkedAt = this.clock();
        try {
          const url = new URL(baseUrl);
          url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/models`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          try {
            const response = await this.fetchImpl(url, { headers: { ...(token ? { "x-api-key": token, Authorization: `Bearer ${token}` } : {}), "anthropic-version": "2023-06-01" }, signal: controller.signal });
            if (!response.ok) throw new Error("listing unavailable");
            const body = await response.json();
            if (!Array.isArray(body.data)) throw new Error("invalid listing");
            remote = unique(body.data.map((entry) => ({ id: entry.id, name: entry.display_name ?? entry.id })));
          } finally { clearTimeout(timer); }
        } catch { remote = []; }
      }
      // A successful relay listing is authoritative for Claude. A configured
      // model that has disappeared upstream must not be offered as a working
      // default just because it remains in the administrator's settings.
      const remoteListed = runtime === "claude" && remote?.length > 0;
      // Claude's --effort help and effortLevel setting do not establish which
      // levels a relay model accepts. Keep those variants hidden without a catalog.
      const models = unique([...local, ...(remote ?? []), ...(runtime === "claude" && !remoteListed ? Object.values(alias).filter(validModel).map((id) => ({ id, name: id })) : []), ...(validModel(defaultModel) && !remoteListed ? [{ id: defaultModel, name: defaultModel }] : [])])
        .map((model) => ({ ...model, variants: local.find((item) => item.id === model.id)?.variants ?? {}, ...(local.find((item) => item.id === model.id)?.inputModalities ? { inputModalities: local.find((item) => item.id === model.id).inputModalities } : {}) }));
      const status = remote?.length || (local.length && (!previous || previous.identityRevision === identityRevision)) ? "ready" : models.length ? "limited" : "unavailable";
      const selectedDefault = models.some((item) => item.id === defaultModel) ? defaultModel
        : models.find((item) => !item.id.includes(":batch"))?.id ?? models[0]?.id ?? null;
      const profile = { runtime, identityRevision, sourceRevision, catalogRevision: digest([models, selectedDefault, status]), models, defaultModel: selectedDefault, status, enabledByProfile: Boolean(models.length), files };
      this.cached.set(runtime, { identityRevision, remote, checkedAt });
      return profile;
    } catch {
      this.cached.delete(runtime);
      return { runtime, identityRevision: null, catalogRevision: null, models: [], defaultModel: null, status: "unavailable", enabledByProfile: false, files: null };
    }
  }

  publicOption(profile) {
    const { runtime, identityRevision: _identity, catalogRevision, models, defaultModel, status, enabledByProfile } = profile;
    return { runtime, catalogRevision, models, defaultModel, status, enabledByProfile };
  }

  async copyForTurn(profile, { paths }) {
    if (!profile.files) throw new Error("CLI profile unavailable");
    const { files } = profile;
    const root = profile.runtime === "claude" ? paths.claudeConfig : paths.codexHome;
    const target = join(root, "profiles", profile.identityRevision, profile.sourceRevision);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const stage = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      const current = await this.refresh(profile.runtime);
      if (current.sourceRevision !== profile.sourceRevision) throw new Error("CLI profile changed during copy; retry the turn");
      const write = async (path, contents) => { await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.writeFile(path, contents, { mode: 0o600 }); };
      let configContent = files.content;
      if (profile.runtime === "codex" && files.catalogContent) {
        const config = parse(configContent);
        config.model_catalog_json = join(target, "codex-models.json");
        configContent = stringify(config);
      }
      await write(join(stage, profile.runtime === "claude" ? "settings.json" : "config.toml"), configContent);
      if (files.auth) await write(join(stage, "auth.json"), files.auth);
      if (files.catalogContent) {
        await write(join(stage, "codex-models.json"), files.catalogContent);
      }
      const verified = await this.refresh(profile.runtime);
      if (verified.sourceRevision !== profile.sourceRevision) throw new Error("CLI profile changed during copy; retry the turn");
      // Native history is mutable and belongs to this user + upstream identity,
      // while each profile's config/auth stays pinned. Sharing only these
      // directories also preserves current history when a catalog is reverted.
      const native = join(dirname(target), "native-state");
      for (const history of ["sessions", "projects"]) {
        const state = join(native, history);
        await fs.mkdir(state, { recursive: true, mode: 0o700 });
        await fs.symlink(state, join(stage, history), "dir");
      }
      const skills = join(paths.home, profile.runtime === "claude" ? ".claude" : ".agents", "skills");
      await fs.mkdir(skills, { recursive: true, mode: 0o700 });
      await fs.symlink(skills, join(stage, "skills"), process.platform === "win32" ? "junction" : "dir");
      await fs.rename(stage, target).catch(async (error) => { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; });
      // Profiles created before skill discovery was connected need this link too.
      await fs.symlink(skills, join(target, "skills"), process.platform === "win32" ? "junction" : "dir")
        .catch((error) => { if (error.code !== "EEXIST") throw error; });
      return { home: paths.home, configDir: target, codexHome: target, env: files.envKey && files.token ? { [files.envKey]: files.token } : {} };
    } finally { await fs.rm(stage, { force: true, recursive: true }); }
  }
}
