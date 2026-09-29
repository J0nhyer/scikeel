import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validModel = (value) => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\r\n\0]/.test(value);
const unique = (items) => [...new Map(items.filter((item) => validModel(item.id)).map((item) => [item.id, item])).values()];
const sourcePath = (home, path) => path?.startsWith("~/") ? join(home, path.slice(2)) : isAbsolute(path ?? "") ? path : join(home, path ?? "");

export class CliProfileResolver {
  constructor({ claudeConfigDir = join(homedir(), ".claude"), codexHome = join(homedir(), ".codex"), fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    this.claudeConfigDir = resolve(claudeConfigDir);
    this.codexHome = resolve(codexHome);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.cached = new Map();
    this.pending = new Map();
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
      const provider = runtime === "codex" ? config.model_providers?.[providerName] ?? config.model_providers?.OpenAI ?? {} : {};
      const baseUrl = runtime === "claude" ? env.ANTHROPIC_BASE_URL : provider.base_url;
      const token = runtime === "claude" ? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY : provider.env_key ? process.env[provider.env_key] : undefined;
      const authPath = runtime === "codex" ? join(home, "auth.json") : null;
      const auth = authPath ? await fs.readFile(authPath, "utf8").catch(() => "") : "";
      const identityRevision = digest([providerName, baseUrl?.replace(/\/+$/, ""), token, auth, provider.wire_api]);
      const alias = { opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL };
      const defaultModel = alias[config.model] ?? config.model ?? null;
      const catalogPath = runtime === "codex" && config.model_catalog_json ? sourcePath(home, config.model_catalog_json) : null;
      const catalogContent = catalogPath ? await fs.readFile(catalogPath, "utf8") : "";
      const catalog = catalogContent ? JSON.parse(catalogContent) : null;
      const local = unique([
        ...(Array.isArray(catalog) ? catalog : Array.isArray(catalog?.models) ? catalog.models : []).map((entry) => typeof entry === "string" ? { id: entry, name: entry } : { id: entry.slug ?? entry.id, name: entry.display_name ?? entry.name ?? entry.slug }),
      ]);
      const files = { main, content, catalogPath, catalogContent, authPath, auth, home, token, baseUrl };
      const previous = this.cached.get(runtime);
      let remote = previous?.identityRevision === identityRevision && this.clock() - previous.checkedAt < 60_000 && !forceRemote ? previous.remote : null;
      if (remote === null && baseUrl && runtime === "claude") {
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
      const models = unique([...local, ...(remote ?? []), ...(runtime === "claude" ? Object.values(alias).filter(validModel).map((id) => ({ id, name: id })) : []), ...(validModel(defaultModel) ? [{ id: defaultModel, name: defaultModel }] : [])]);
      const status = local.length || (remote?.length ?? 0) ? "ready" : models.length ? "limited" : "unavailable";
      const profile = { runtime, identityRevision, catalogRevision: digest([identityRevision, catalogContent, config.model, alias, remote, status]), models, defaultModel: models.some((item) => item.id === defaultModel) ? defaultModel : models[0]?.id ?? null, status, enabledByProfile: Boolean(models.length), files };
      this.cached.set(runtime, { identityRevision, remote, checkedAt: this.clock() });
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
    const target = join(root, "profiles", profile.identityRevision);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const stage = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      const current = await this.refresh(profile.runtime);
      if (current.identityRevision !== profile.identityRevision || current.catalogRevision !== profile.catalogRevision) throw new Error("CLI profile changed during copy; retry the turn");
      const write = async (path, contents) => { await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.writeFile(path, contents, { mode: 0o600 }); };
      await write(join(stage, profile.runtime === "claude" ? "settings.json" : "config.toml"), files.content);
      if (files.auth) await write(join(stage, "auth.json"), files.auth);
      if (files.catalogContent) {
        await write(join(stage, "codex-models.json"), files.catalogContent);
        const catalogName = files.catalogPath;
        if (catalogName?.startsWith(files.home)) await write(join(stage, catalogName.slice(files.home.length + 1)), files.catalogContent);
      }
      const verified = await this.refresh(profile.runtime);
      if (verified.identityRevision !== profile.identityRevision || verified.catalogRevision !== profile.catalogRevision) throw new Error("CLI profile changed during copy; retry the turn");
      await fs.rename(stage, target).catch(async (error) => { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; });
      return { home: paths.home, configDir: target, codexHome: target };
    } finally { await fs.rm(stage, { force: true, recursive: true }); }
  }
}
