import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const RUNTIME_ORDER = ["opencode", "claude", "codex"];
const RUNTIMES = new Set(RUNTIME_ORDER);
const MANAGED_RUNTIMES = new Set(["claude", "codex"]);
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID = /^ses_cli_[A-Za-z0-9_-]{16,80}$/;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_HISTORY_MESSAGES = 500;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 160;

function now() {
  return Date.now();
}

function iso(timestamp = now()) {
  return new Date(timestamp).toISOString();
}

function issue(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function assertUserId(value) {
  if (typeof value !== "string" || !USER_ID.test(value)) throw issue("invalid_user", "invalid user id");
  return value;
}

function assertRuntime(value) {
  if (!RUNTIMES.has(value)) throw issue("invalid_runtime", "runtime must be opencode, claude, or codex");
  return value;
}

function normalizeModelId(value) {
  if (typeof value !== "string") throw issue("invalid_model", "model must be a string");
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH || /[\r\n\0]/.test(model)) {
    throw issue("invalid_model", "model must be 1-160 characters on one line");
  }
  return model;
}

function normalizeModelList(values) {
  if (!Array.isArray(values)) throw issue("invalid_models", "models must be an array");
  return [...new Set(values.map(normalizeModelId))];
}

function runtimeDescriptor(runtime) {
  const managed = runtime !== "opencode";
  return {
    runtime,
    kind: managed ? "server" : "opencode",
    managed,
    label: runtime === "claude" ? "Claude Code" : runtime === "codex" ? "Codex" : "OpenCode",
  };
}

function managedModelKey(runtime, model) {
  return model ? `${runtime}/${model}` : null;
}

function modelFromManagedKey(runtime, value) {
  const key = normalizeModelId(value);
  const prefix = `${runtime}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw issue("invalid_model", `model must start with ${prefix}`);
  }
  return key.slice(prefix.length);
}

function emptyManagedRuntimes() {
  return {
    claude: { models: [], defaultModel: null },
    codex: { models: [], defaultModel: null },
  };
}

function normalizedManagedRuntime(value) {
  const models = normalizeModelList(value?.models ?? []);
  if (models.length === 0) return { models, defaultModel: null };
  const defaultModel = normalizeModelId(value?.defaultModel);
  if (!models.includes(defaultModel)) {
    throw issue("invalid_default_model", "defaultModel must be included in models");
  }
  return { models, defaultModel };
}

function assertSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw issue("invalid_session", "invalid session id");
  return value;
}

async function ensureDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(path, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes.
  }
}

async function writePrivate(path, content) {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  try {
    await fs.chmod(temporary, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  await fs.rename(temporary, path);
}

async function copyPrivate(source, destination) {
  try {
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    await fs.chmod(destination, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return true;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readBody(request) {
  const claimed = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(claimed) && claimed > MAX_BODY_BYTES) {
    throw issue("body_too_large", "request body is too large", 413);
  }
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(issue("body_too_large", "request body is too large", 413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolvePromise(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.on("aborted", () => {
      if (!settled) {
        settled = true;
        reject(issue("aborted", "request aborted", 400));
      }
    });
  });
}

async function jsonBody(request) {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be a JSON object");
    }
    return value;
  } catch (error) {
    throw issue("invalid_json", error?.message ?? "invalid JSON body", 400);
  }
}

function jsonHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response, status, body, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(status, { ...jsonHeaders(), ...extraHeaders });
  response.end(JSON.stringify(body));
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    parentID: session.parentId ?? null,
    time: { created: session.createdAt, updated: session.updatedAt },
    metadata: session.metadata ?? {},
    ...(session.model ? { model: session.model } : {}),
  };
}

function textPart(text, messageId, sessionId, partId = `prt_cli_${randomUUID()}`) {
  return {
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  };
}

function toolPart({ sessionId, messageId, callId, title, status, input, output }) {
  return {
    id: `prt_cli_${callId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool",
    callID: callId,
    tool: "bash",
    state: {
      status,
      title,
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    },
  };
}

/**
 * Server-side adapter for the already-installed native Claude Code and Codex
 * CLIs. It intentionally exposes an OpenCode-shaped HTTP surface so the
 * existing Web client can keep using packages/sdk/OpenCodeClient.
 *
 * The administrator's config is copied into a private per-user runtime home
 * before a turn. Native histories never share a directory with another user,
 * and no provider credential is returned by this class or its HTTP handlers.
 */
export class CliRuntimeManager {
  constructor({
    rootDir,
    runtime = "opencode",
    claudeCommand = "claude",
    claudeArgs = [],
    codexCommand = "codex",
    codexArgs = [],
    claudeConfigDir = join(homedir(), ".claude"),
    codexHome = join(homedir(), ".codex"),
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    spawnImpl = nodeSpawn,
    logger = () => {},
  } = {}) {
    if (!rootDir) throw new Error("rootDir is required");
    this.rootDir = resolve(rootDir);
    this.usersDir = join(this.rootDir, "users");
    this.configPath = join(this.rootDir, "runtime.json");
    this.defaultRuntime = assertRuntime(runtime);
    this.initialRuntime = this.defaultRuntime;
    this.userRuntimes = new Map();
    this.userModels = new Map();
    this.managedRuntimes = emptyManagedRuntimes();
    this.claudeCommand = claudeCommand;
    this.claudeArgs = [...claudeArgs];
    this.codexCommand = codexCommand;
    this.codexArgs = [...codexArgs];
    this.claudeConfigDir = resolve(claudeConfigDir);
    this.codexHome = resolve(codexHome);
    this.turnTimeoutMs = turnTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.userStates = new Map();
    this.processes = new Map();
    this.subscribers = new Map();
    this.persistQueues = new Map();
    this.configPersistQueue = Promise.resolve();
    this.initialized = false;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return;
    await ensureDirectory(this.rootDir);
    await ensureDirectory(this.usersDir);
    const configured = await readJson(this.configPath, null);
    let persist = false;
    if (configured?.version === 3) {
      if (configured.defaultRuntime) this.defaultRuntime = assertRuntime(configured.defaultRuntime);
      if (configured.userRuntimes && typeof configured.userRuntimes === "object") {
        for (const [userId, runtime] of Object.entries(configured.userRuntimes)) {
          if (!USER_ID.test(userId) || !RUNTIMES.has(runtime)) continue;
          this.userRuntimes.set(userId, runtime);
        }
      }
      if (configured.userModels && typeof configured.userModels === "object") {
        for (const [userId, choices] of Object.entries(configured.userModels)) {
          if (!USER_ID.test(userId) || !choices || typeof choices !== "object" || Array.isArray(choices)) continue;
          const normalized = {};
          for (const runtime of MANAGED_RUNTIMES) {
            if (choices[runtime] === undefined) continue;
            normalized[runtime] = normalizeModelId(choices[runtime]);
          }
          if (Object.keys(normalized).length > 0) this.userModels.set(userId, normalized);
        }
      }
      for (const runtime of MANAGED_RUNTIMES) {
        this.managedRuntimes[runtime] = normalizedManagedRuntime(configured.managedRuntimes?.[runtime]);
      }
    } else if (configured?.version === 2) {
      if (configured.defaultRuntime) this.defaultRuntime = assertRuntime(configured.defaultRuntime);
      if (configured.userRuntimes && typeof configured.userRuntimes === "object") {
        for (const [userId, runtime] of Object.entries(configured.userRuntimes)) {
          if (!USER_ID.test(userId) || !RUNTIMES.has(runtime)) continue;
          this.userRuntimes.set(userId, runtime);
        }
      }
      this.managedRuntimes = await this.seedManagedRuntimes();
      persist = true;
    } else if (configured?.runtime) {
      // Version 1 stored one global switch. Migrating that value would keep the
      // exact multi-user bug this format replaces, so every user starts on the
      // original OpenCode runtime and may opt into a managed CLI independently.
      this.defaultRuntime = "opencode";
      this.managedRuntimes = await this.seedManagedRuntimes();
      persist = true;
    } else {
      this.managedRuntimes = await this.seedManagedRuntimes();
      persist = true;
    }
    if (persist) await this.persistRuntime();
    this.initialized = true;
  }

  async seedManagedRuntimes() {
    const seeded = emptyManagedRuntimes();
    try {
      const settings = JSON.parse(await fs.readFile(join(this.claudeConfigDir, "settings.json"), "utf8"));
      const model = normalizeModelId(settings?.model);
      seeded.claude = { models: [model], defaultModel: model };
    } catch {
      // A missing, unreadable, or invalid default leaves Claude unavailable
      // until an administrator explicitly configures its model catalog.
    }
    try {
      const config = await fs.readFile(join(this.codexHome, "config.toml"), "utf8");
      const match = config.match(/^model\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m);
      if (match) {
        const model = normalizeModelId(JSON.parse(match[1]));
        seeded.codex = { models: [model], defaultModel: model };
      }
    } catch {
      // A missing, unreadable, or invalid default leaves Codex unavailable
      // until an administrator explicitly configures its model catalog.
    }
    return seeded;
  }

  async persistRuntime() {
    const snapshot = {
      version: 3,
      defaultRuntime: this.defaultRuntime,
      userRuntimes: Object.fromEntries([...this.userRuntimes].sort(([a], [b]) => a.localeCompare(b))),
      userModels: Object.fromEntries(
        [...this.userModels]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([userId, choices]) => [userId, { ...choices }]),
      ),
      managedRuntimes: structuredClone(this.managedRuntimes),
    };
    const next = this.configPersistQueue.then(() =>
      writePrivate(this.configPath, `${JSON.stringify(snapshot, null, 2)}\n`),
    );
    this.configPersistQueue = next.catch(() => {});
    await next;
  }

  runtimeForUser(userId) {
    assertUserId(userId);
    return this.userRuntimes.get(userId) ?? this.defaultRuntime;
  }

  modelForUser(userId, runtime = this.runtimeForUser(userId)) {
    assertUserId(userId);
    if (!MANAGED_RUNTIMES.has(runtime)) return null;
    const config = this.managedRuntimes[runtime];
    const selected = this.userModels.get(userId)?.[runtime];
    return selected && config.models.includes(selected) ? selected : config.defaultModel;
  }

  async setUserModel(userId, runtime, model) {
    await this.init();
    assertUserId(userId);
    if (!MANAGED_RUNTIMES.has(runtime)) {
      throw issue("invalid_runtime", "OpenCode manages its own models");
    }
    const selected = normalizeModelId(model);
    const config = this.managedRuntimes[runtime];
    if (!config.models.includes(selected)) {
      throw issue("model_not_enabled", `model ${selected} is not enabled for ${runtime}`);
    }
    this.userModels.set(userId, { ...(this.userModels.get(userId) ?? {}), [runtime]: selected });
    await this.persistRuntime();
    return this.describe(userId);
  }

  async setManagedRuntime(runtime, models, defaultModel) {
    await this.init();
    if (!MANAGED_RUNTIMES.has(runtime)) {
      throw issue("invalid_runtime", "only Claude Code and Codex are managed here");
    }
    const normalized = normalizeModelList(models);
    const selectedDefault = normalized.length === 0 ? null : normalizeModelId(defaultModel);
    if (selectedDefault && !normalized.includes(selectedDefault)) {
      throw issue("invalid_default_model", "defaultModel must be included in models");
    }
    const previousRuntime = structuredClone(this.managedRuntimes[runtime]);
    const previousUserModels = new Map(
      [...this.userModels].map(([userId, choices]) => [userId, { ...choices }]),
    );
    this.managedRuntimes[runtime] = { models: normalized, defaultModel: selectedDefault };
    for (const [userId, choices] of this.userModels) {
      if (choices[runtime] && !normalized.includes(choices[runtime])) {
        const next = { ...choices };
        if (selectedDefault) next[runtime] = selectedDefault;
        else delete next[runtime];
        if (Object.keys(next).length > 0) this.userModels.set(userId, next);
        else this.userModels.delete(userId);
      }
    }
    try {
      await this.persistRuntime();
    } catch (error) {
      this.managedRuntimes[runtime] = previousRuntime;
      this.userModels = previousUserModels;
      throw error;
    }
    return this.adminDescribe();
  }

  async setUserRuntime(userId, runtime, model) {
    await this.init();
    assertUserId(userId);
    const selected = assertRuntime(runtime);
    const current = this.runtimeForUser(userId);
    let selectedModel = null;
    if (MANAGED_RUNTIMES.has(selected)) {
      const config = this.managedRuntimes[selected];
      if (config.models.length === 0 || !config.defaultModel) {
        throw issue("runtime_unconfigured", `${runtimeDescriptor(selected).label} has no administrator-enabled models`);
      }
      selectedModel = model === undefined ? this.modelForUser(userId, selected) : normalizeModelId(model);
      if (!config.models.includes(selectedModel)) {
        throw issue("model_not_enabled", `model ${selectedModel} is not enabled for ${selected}`);
      }
    }
    if (selected !== current) {
      const state = await this.ensureUser(userId);
      if ([...state.sessions.values()].some((session) => session.status === "running")) {
        throw issue("runtime_busy", "wait for the current agent turn to finish before switching runtime", 409);
      }
    }
    this.userRuntimes.set(userId, selected);
    if (selectedModel && model !== undefined) {
      this.userModels.set(userId, { ...(this.userModels.get(userId) ?? {}), [selected]: selectedModel });
    }
    await this.persistRuntime();
    return this.describe(userId);
  }

  runtimeOption(runtime, userId = null) {
    const descriptor = runtimeDescriptor(runtime);
    if (!MANAGED_RUNTIMES.has(runtime)) {
      return { ...descriptor, enabled: true, models: [], defaultModel: null, selectedModel: null };
    }
    const config = this.managedRuntimes[runtime];
    return {
      ...descriptor,
      enabled: config.models.length > 0 && Boolean(config.defaultModel),
      models: [...config.models],
      defaultModel: config.defaultModel,
      selectedModel: userId ? this.modelForUser(userId, runtime) : null,
    };
  }

  describe(userId) {
    const selected = this.runtimeForUser(userId);
    return {
      ...this.runtimeOption(selected, userId),
      model: this.modelForUser(userId, selected),
      available: RUNTIME_ORDER.map((runtime) => this.runtimeOption(runtime, userId)),
    };
  }

  adminDescribe() {
    return {
      defaultRuntime: this.defaultRuntime,
      available: RUNTIME_ORDER.map((runtime) => this.runtimeOption(runtime)),
      managedRuntimes: structuredClone(this.managedRuntimes),
      commands: {
        claude: this.claudeCommand,
        codex: this.codexCommand,
      },
    };
  }

  isManaged(userId) {
    return this.runtimeForUser(userId) !== "opencode";
  }

  userPaths(userId) {
    assertUserId(userId);
    const root = join(this.usersDir, userId);
    return {
      root,
      sessionsPath: join(root, "sessions.json"),
      home: join(root, "home"),
      claudeConfig: join(root, "claude-config"),
      codexHome: join(root, "codex-home"),
    };
  }

  async ensureUser(userId) {
    await this.init();
    const existing = this.userStates.get(userId);
    if (existing) return existing;
    const paths = this.userPaths(userId);
    await ensureDirectory(paths.root);
    await ensureDirectory(paths.home);
    const loaded = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
    const sessions = new Map();
    for (const session of Array.isArray(loaded?.sessions) ? loaded.sessions : []) {
      if (!session || session.userId !== userId || !SESSION_ID.test(session.id)) continue;
      if (typeof session.directory !== "string" || typeof session.title !== "string") continue;
      sessions.set(session.id, {
        ...session,
        history: Array.isArray(session.history) ? session.history : [],
        metadata: session.metadata && typeof session.metadata === "object" ? session.metadata : {},
        status: "idle",
      });
    }
    const state = { userId, paths, sessions };
    this.userStates.set(userId, state);
    return state;
  }

  async persistUser(state) {
    const snapshot = {
      version: 1,
      sessions: [...state.sessions.values()].map(({ status: _status, ...session }) => session),
    };
    const previous = this.persistQueues.get(state.userId) ?? Promise.resolve();
    const next = previous.then(() => writePrivate(state.paths.sessionsPath, `${JSON.stringify(snapshot, null, 2)}\n`));
    this.persistQueues.set(state.userId, next.catch(() => {}));
    await next;
  }

  async syncCredentials(state, runtime) {
    const { paths } = state;
    await ensureDirectory(paths.home);
    if (runtime === "claude") {
      await ensureDirectory(paths.claudeConfig);
      await copyPrivate(join(this.claudeConfigDir, "settings.json"), join(paths.claudeConfig, "settings.json"));
      return;
    }
    if (runtime === "codex") {
      await ensureDirectory(paths.codexHome);
      for (const name of ["auth.json", "config.toml", "codex-models.json"]) {
        await copyPrivate(join(this.codexHome, name), join(paths.codexHome, name));
      }
      // The administrator's config commonly refers to this catalog through
      // `~/.codex/codex-models.json`. HOME is private per user, while
      // CODEX_HOME intentionally points at a sibling directory, so mirror
      // this non-secret catalog at the path that the copied config resolves.
      await ensureDirectory(join(paths.home, ".codex"));
      await copyPrivate(
        join(this.codexHome, "codex-models.json"),
        join(paths.home, ".codex", "codex-models.json"),
      );
      const sourceRules = join(this.codexHome, "rules", "default.rules");
      const targetRules = join(paths.codexHome, "rules", "default.rules");
      await ensureDirectory(dirname(targetRules));
      await copyPrivate(sourceRules, targetRules);
    }
  }

  childEnvironment(state, runtime) {
    const keep = new Set([
      "PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
      "TZ",
      "NO_COLOR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "TMPDIR",
      "TMP",
      "TEMP",
    ]);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (keep.has(key) && typeof value === "string") env[key] = value;
    }
    env.HOME = state.paths.home;
    env.XDG_CONFIG_HOME = join(state.paths.home, ".config");
    env.XDG_CACHE_HOME = join(state.paths.home, ".cache");
    env.XDG_DATA_HOME = join(state.paths.home, ".local", "share");
    if (runtime === "claude") {
      env.CLAUDE_CONFIG_DIR = state.paths.claudeConfig;
      env.ANTHROPIC_CONFIG_DIR = state.paths.claudeConfig;
    }
    if (runtime === "codex") env.CODEX_HOME = state.paths.codexHome;
    return env;
  }

  commandFor(state, session, text) {
    const runtime = session.runtime;
    const model = this.modelForUser(session.userId, runtime);
    if (!model) {
      throw issue("runtime_unconfigured", `${runtimeDescriptor(runtime).label} has no administrator-enabled models`);
    }
    if (runtime === "claude") {
      const args = [
        ...this.claudeArgs,
        "-p",
        text,
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "auto",
        "--add-dir",
        session.directory,
      ];
      if (session.nativeSessionId) args.push("--resume", session.nativeSessionId);
      else args.push("--session-id", randomUUID());
      return { command: this.claudeCommand, args };
    }
    const args = [
      ...this.codexArgs,
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      session.directory,
      "-s",
      "workspace-write",
      "--model",
      model,
      ...(session.nativeSessionId ? ["resume", session.nativeSessionId] : []),
      text,
    ];
    return { command: this.codexCommand, args };
  }

  async createSession({ userId, workspaceDir, directory = workspaceDir, title = "New session" }) {
    const state = await this.ensureUser(userId);
    const runtime = this.runtimeForUser(userId);
    if (runtime === "opencode") {
      throw issue("unmanaged_runtime", "OpenCode sessions are handled by the user's worker", 409);
    }
    const safeDirectory = resolve(directory);
    if (!isWithin(workspaceDir, safeDirectory)) throw issue("invalid_directory", "session directory is outside the user workspace", 403);
    const timestamp = now();
    const id = `ses_cli_${randomUUID().replaceAll("-", "")}`;
    const session = {
      id,
      userId,
      runtime,
      nativeSessionId: null,
      directory: safeDirectory,
      title: typeof title === "string" && title.trim() ? title.trim().slice(0, 240) : "New session",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
      history: [],
      status: "idle",
    };
    state.sessions.set(id, session);
    await this.persistUser(state);
    return session;
  }

  async getOwnedSession(userId, sessionId) {
    const state = await this.ensureUser(userId);
    assertSessionId(sessionId);
    const session = state.sessions.get(sessionId);
    if (!session || session.runtime !== this.runtimeForUser(userId)) {
      throw issue("unknown_session", "session not found in the selected runtime", 404);
    }
    return { state, session };
  }

  async listSessions({ userId, search = "", limit = 200 }) {
    const state = await this.ensureUser(userId);
    const runtime = this.runtimeForUser(userId);
    const query = typeof search === "string" ? search.trim().toLowerCase() : "";
    const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
    return [...state.sessions.values()]
      .filter((session) => session.runtime === runtime)
      .filter((session) => !query || session.title.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max)
      .map(publicSession);
  }

  emit(userId, event) {
    const subscribers = this.subscribers.get(userId);
    if (!subscribers) return;
    const sessionId = event.properties?.sessionID;
    const session = sessionId ? this.userStates.get(userId)?.sessions.get(sessionId) : null;
    for (const subscription of [...subscribers]) {
      if (session && subscription.directory && resolve(subscription.directory) !== resolve(session.directory)) continue;
      try {
        subscription.response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        subscribers.delete(subscription);
      }
    }
  }

  async subscribe(userId, request, response) {
    const parsed = new URL(request.url ?? "/", "http://platform.invalid");
    const directory = parsed.searchParams.get("directory");
    await this.ensureUser(userId);
    const subscription = { response, directory };
    let set = this.subscribers.get(userId);
    if (!set) this.subscribers.set(userId, (set = new Set()));
    set.add(subscription);
    response.writeHead(200, {
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.write(": connected\n\n");
    const remove = () => {
      set.delete(subscription);
      if (set.size === 0) this.subscribers.delete(userId);
    };
    request.on("aborted", remove);
    response.on("close", remove);
  }

  emitMessageUpdated(userId, session, message) {
    this.emit(userId, {
      type: "message.updated",
      properties: { info: { ...message.info, sessionID: session.id } },
    });
  }

  emitText(userId, session, message, part) {
    this.emit(userId, {
      type: "message.part.updated",
      properties: { part: { ...part, sessionID: session.id, messageID: message.info.id } },
    });
  }

  emitTool(userId, session, message, part) {
    this.emit(userId, {
      type: "message.part.updated",
      properties: { part: { ...part, sessionID: session.id, messageID: message.info.id } },
    });
  }

  async sendPrompt({ userId, sessionId, text }) {
    const { state, session } = await this.getOwnedSession(userId, sessionId);
    if (session.status === "running") throw issue("session_busy", "session is already running", 409);
    if (typeof text !== "string" || !text.trim()) throw issue("empty_prompt", "prompt is empty");
    const childSpec = this.commandFor(state, session, text);
    await this.syncCredentials(state, session.runtime);
    const timestamp = now();
    const userMessage = {
      info: {
        id: `msg_cli_${randomUUID()}`,
        role: "user",
        sessionID: session.id,
        time: { created: timestamp, completed: timestamp },
      },
      parts: [textPart(text, `msg_cli_user_${randomUUID()}`, session.id)],
    };
    session.history.push(userMessage);
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
    session.status = "running";
    session.updatedAt = timestamp;
    await this.persistUser(state);

    const assistantMessage = {
      info: {
        id: `msg_cli_${randomUUID()}`,
        role: "assistant",
        sessionID: session.id,
        time: { created: timestamp },
      },
      parts: [],
    };
    this.emitMessageUpdated(userId, session, assistantMessage);
    let child;
    try {
      child = this.spawnImpl(childSpec.command, childSpec.args, {
        cwd: session.directory,
        env: this.childEnvironment(state, session.runtime),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const completed = now();
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.info.time.completed = completed;
      assistantMessage.info.error = { name: "CliRuntimeError", data: { message } };
      session.history.push(assistantMessage);
      session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
      session.status = "idle";
      session.updatedAt = completed;
      await this.persistUser(state);
      this.emit(userId, {
        type: "session.error",
        properties: { sessionID: session.id, error: assistantMessage.info.error },
      });
      this.emit(userId, { type: "session.idle", properties: { sessionID: session.id } });
      this.logger({ type: "cli.turn.error", userId, sessionId: session.id, runtime: session.runtime, error: message });
      return;
    }
    this.processes.set(session.id, child);
    const output = { stderr: "", stdout: "" };
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, this.turnTimeoutMs);
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (this.processes.get(session.id) === child) this.processes.delete(session.id);
      const completed = now();
      assistantMessage.info.time.completed = completed;
      const errorText = session._error ?? (code === 0 ? "" : output.stderr.trim() || `agent exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
      delete session._error;
      if (errorText) {
        assistantMessage.info.error = { name: "CliRuntimeError", data: { message: errorText } };
        this.emit(userId, {
          type: "session.error",
          properties: { sessionID: session.id, error: assistantMessage.info.error },
        });
      }
      if (assistantMessage.parts.length > 0 || assistantMessage.info.error) {
        session.history.push(assistantMessage);
        session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
      }
      session.status = "idle";
      session.updatedAt = completed;
      await this.persistUser(state);
      this.emit(userId, { type: "session.idle", properties: { sessionID: session.id } });
      this.logger({ type: "cli.turn.finished", userId, sessionId: session.id, runtime: session.runtime, code, signal });
    };
    const parseLine = (line) => {
      const textLine = String(line).trim();
      if (!textLine) return;
      let event;
      try {
        event = JSON.parse(textLine);
      } catch {
        return;
      }
      if (session.runtime === "claude") this.parseClaudeEvent(userId, session, assistantMessage, event);
      else this.parseCodexEvent(userId, session, assistantMessage, event);
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk) => {
      output.stdout = `${output.stdout}${chunk}`.slice(-32_000);
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        parseLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    child.stderr?.on("data", (chunk) => {
      output.stderr = `${output.stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", (error) => {
      session._error = error.message;
    });
    child.once("exit", (code, signal) => {
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      void finish(code, signal).catch((error) => this.logger({ type: "cli.turn.persist_error", error: error.message }));
    });
    this.logger({ type: "cli.turn.started", userId, sessionId: session.id, runtime: session.runtime });
  }

  parseClaudeEvent(userId, session, assistantMessage, event) {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      session.nativeSessionId = event.session_id;
      return;
    }
    if (event.type === "assistant") {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          this.appendAssistantText(userId, session, assistantMessage, block.text);
        } else if (block?.type === "tool_use") {
          const part = toolPart({
            sessionId: session.id,
            messageId: assistantMessage.info.id,
            callId: block.id ?? randomUUID(),
            title: block.name ?? "tool",
            status: "running",
            input: block.input,
          });
          assistantMessage.parts.push(part);
          this.emitTool(userId, session, assistantMessage, part);
        }
      }
      return;
    }
    if (event.type === "result") {
      if (event.is_error && typeof event.result === "string") session._error = event.result;
      else if (typeof event.result === "string" && event.result && assistantMessage.parts.length === 0) {
        this.appendAssistantText(userId, session, assistantMessage, event.result);
      }
    }
  }

  parseCodexEvent(userId, session, assistantMessage, event) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      session.nativeSessionId = event.thread_id;
      return;
    }
    if (event.type !== "item.completed" && event.type !== "item.started") return;
    const item = event.item ?? {};
    if (item.type === "agent_message" && typeof item.text === "string") {
      this.appendAssistantText(userId, session, assistantMessage, item.text);
      return;
    }
    if (item.type === "error" && typeof item.message === "string") {
      session._error = item.message;
      return;
    }
    if (item.type === "command_execution") {
      const callId = item.id ?? randomUUID();
      const status = event.type === "item.started" ? "running" : item.exit_code === 0 ? "completed" : "error";
      const part = toolPart({
        sessionId: session.id,
        messageId: assistantMessage.info.id,
        callId,
        title: item.command ?? "command",
        status,
        input: item.command ? { command: item.command } : undefined,
        output: item.aggregated_output,
      });
      const previous = assistantMessage.parts.find((candidate) => candidate.callID === callId);
      if (previous) Object.assign(previous, part, { id: previous.id });
      else assistantMessage.parts.push(part);
      this.emitTool(userId, session, assistantMessage, previous ?? part);
    }
  }

  appendAssistantText(userId, session, assistantMessage, text) {
    let part = assistantMessage.parts.find((candidate) => candidate.type === "text");
    if (!part) {
      part = textPart("", assistantMessage.info.id, session.id);
      assistantMessage.parts.push(part);
    }
    part.text = `${part.text ?? ""}${text}`;
    this.emitText(userId, session, assistantMessage, part);
  }

  async abortSession(userId, sessionId) {
    const { session } = await this.getOwnedSession(userId, sessionId);
    const child = this.processes.get(session.id);
    if (child) child.kill("SIGTERM");
  }

  async handle(request, response, { userId, workspaceDir }) {
    await this.init();
    if (!this.isManaged(userId)) return false;
    const parsed = new URL(request.url ?? "/", "http://platform.invalid");
    const path = parsed.pathname;
    if (request.method === "GET" && path === "/event") {
      await this.subscribe(userId, request, response);
      return true;
    }
    if (path === "/experimental/session" && request.method === "GET") {
      sendJson(response, 200, await this.listSessions({
        userId,
        search: parsed.searchParams.get("search") ?? "",
        limit: parsed.searchParams.get("limit") ?? 200,
      }));
      return true;
    }
    if (path === "/session" && request.method === "GET") {
      sendJson(response, 200, await this.listSessions({ userId }));
      return true;
    }
    if (path === "/session" && request.method === "POST") {
      let body;
      try {
        body = await jsonBody(request);
        const directory = parsed.searchParams.get("directory") ?? workspaceDir;
        sendJson(response, 200, { id: (await this.createSession({ userId, workspaceDir, directory, title: body.title })).id });
      } catch (error) {
        sendJson(response, error.status ?? 400, { error: error.message });
      }
      return true;
    }
    if (path === "/experimental/control-plane/move-session" && request.method === "POST") {
      try {
        const body = await jsonBody(request);
        const { state, session } = await this.getOwnedSession(userId, body.sessionID);
        const destination = body.destination?.directory;
        if (typeof destination !== "string" || !isWithin(workspaceDir, destination)) throw issue("invalid_directory", "destination is outside the user workspace", 403);
        session.directory = resolve(destination);
        session.updatedAt = now();
        await this.persistUser(state);
        sendJson(response, 200, {});
      } catch (error) {
        sendJson(response, error.status ?? 400, { error: error.message });
      }
      return true;
    }
    const match = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      let sessionId;
      try {
        sessionId = decodeURIComponent(match[1]);
      } catch {
        sendJson(response, 400, { error: "invalid session id" });
        return true;
      }
      const route = match[2] ?? "";
      try {
        if (route === "message" && request.method === "GET") {
          const { session } = await this.getOwnedSession(userId, sessionId);
          sendJson(response, 200, session.history);
        } else if (!route && request.method === "GET") {
          const { session } = await this.getOwnedSession(userId, sessionId);
          sendJson(response, 200, publicSession(session));
        } else if (!route && request.method === "PATCH") {
          const { state, session } = await this.getOwnedSession(userId, sessionId);
          const body = await jsonBody(request);
          if (typeof body.title === "string" && body.title.trim()) session.title = body.title.trim().slice(0, 240);
          if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) session.metadata = body.metadata;
          session.updatedAt = now();
          await this.persistUser(state);
          sendJson(response, 200, publicSession(session));
        } else if (!route && request.method === "DELETE") {
          const { state, session } = await this.getOwnedSession(userId, sessionId);
          const child = this.processes.get(session.id);
          if (child) child.kill("SIGTERM");
          state.sessions.delete(session.id);
          await this.persistUser(state);
          sendJson(response, 200, true);
        } else if (route === "prompt_async" && request.method === "POST") {
          const body = await jsonBody(request);
          const text = Array.isArray(body.parts)
            ? body.parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
            : "";
          void this.sendPrompt({ userId, sessionId, text }).catch((error) => {
            this.logger({ type: "cli.turn.error", userId, sessionId, error: error.message });
          });
          sendJson(response, 202, {});
        } else if (route === "abort" && request.method === "POST") {
          await this.abortSession(userId, sessionId);
          sendJson(response, 200, true);
        } else if (route === "command" && request.method === "POST") {
          const body = await jsonBody(request);
          const command = typeof body.command === "string" ? body.command : "";
          const args = typeof body.arguments === "string" ? body.arguments : "";
          void this.sendPrompt({ userId, sessionId, text: `/${command}${args ? ` ${args}` : ""}` }).catch((error) => {
            this.logger({ type: "cli.command.error", userId, sessionId, error: error.message });
          });
          sendJson(response, 202, {});
        } else if (route === "shell" && request.method === "POST") {
          sendJson(response, 501, { error: "direct shell commands are disabled in the administrator-managed runtime" });
        } else if (route === "fork" && request.method === "POST") {
          const { session } = await this.getOwnedSession(userId, sessionId);
          const copy = await this.createSession({ userId, workspaceDir, directory: session.directory, title: `${session.title} (fork)` });
          const target = await this.getOwnedSession(userId, copy.id);
          target.session.history = session.history.slice();
          await this.persistUser(target.state);
          sendJson(response, 200, { id: copy.id });
        } else if (["revert", "unrevert", "summarize"].includes(route.split("/")[0])) {
          sendJson(response, 501, { error: `${route} is not available in the administrator-managed CLI runtime` });
        } else {
          sendJson(response, 404, { error: "not found" });
        }
      } catch (error) {
        sendJson(response, error.status ?? 400, { error: error.message });
      }
      return true;
    }
    if (path === "/agent" && request.method === "GET") {
      sendJson(response, 200, [{ name: "build", mode: "primary", description: this.describe(userId).label }]);
      return true;
    }
    if (path === "/command" && request.method === "GET") {
      sendJson(response, 200, []);
      return true;
    }
    if (path === "/skill" && request.method === "GET") {
      sendJson(response, 200, []);
      return true;
    }
    if (path === "/global/config" && request.method === "GET") {
      const runtime = this.runtimeForUser(userId);
      sendJson(response, 200, { model: managedModelKey(runtime, this.modelForUser(userId, runtime)) });
      return true;
    }
    if (path === "/global/config" && request.method === "PATCH") {
      try {
        const body = await jsonBody(request);
        if (Object.keys(body).length !== 1 || typeof body.model !== "string") {
          throw issue("invalid_config", "only the selected model may be changed");
        }
        const runtime = this.runtimeForUser(userId);
        const model = modelFromManagedKey(runtime, body.model);
        await this.setUserModel(userId, runtime, model);
        sendJson(response, 200, { model: managedModelKey(runtime, model) });
      } catch (error) {
        sendJson(response, error.status ?? 400, { error: error.message });
      }
      return true;
    }
    if (path === "/config/providers" && request.method === "GET") {
      const runtime = this.runtimeForUser(userId);
      const { models } = this.managedRuntimes[runtime];
      sendJson(response, 200, {
        providers: [{
          id: runtime,
          name: runtimeDescriptor(runtime).label,
          models: Object.fromEntries(models.map((model) => [
            model,
            { name: model, variants: {}, limit: { context: 0 } },
          ])),
        }],
      });
      return true;
    }
    if (path === "/provider" && request.method === "GET") {
      sendJson(response, 200, { all: [], connected: [] });
      return true;
    }
    if (path === "/provider/auth" && request.method === "GET") {
      sendJson(response, 200, {});
      return true;
    }
    if ((path === "/question" || path === "/permission") && request.method === "GET") {
      sendJson(response, 200, []);
      return true;
    }
    if (path === "/instance/dispose" && request.method === "POST") {
      sendJson(response, 200, {});
      return true;
    }
    return false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.processes.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
    this.processes.clear();
    for (const set of this.subscribers.values()) {
      for (const subscription of set) subscription.response.end();
    }
    this.subscribers.clear();
    await Promise.all([...this.persistQueues.values()].map((queue) => queue.catch(() => {})));
    await this.configPersistQueue.catch(() => {});
  }
}
