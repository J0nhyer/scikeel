import { claudeUserInput, codexImageArgs } from "./attachment-input.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliProfileResolver } from "./cli-profile.mjs";
import { AssistantPolicy, validateAssistantPolicyState } from "./assistant-policy.mjs";
import {handoverText,prepareHandover} from './conversation-handover.mjs';
import {nativePublicMessageId} from './conversation-router.mjs';
import { metadataFacts } from '@ai4s/sdk/agent-analytics-observer';
export {handoverText} from './conversation-handover.mjs';
export const RUNTIME_STORAGE_VERSION = 5;
export const READABLE_RUNTIME_STORAGE_VERSIONS = Object.freeze([1, 2, 3, 4, 5]);
import { discoverSkills, seedSkills } from "./skills.mjs";

const RUNTIME_ORDER = ["opencode", "claude", "codex"];
const RUNTIMES = new Set(RUNTIME_ORDER);
const MANAGED_RUNTIMES = new Set(["claude", "codex"]);
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID = /^ses_cli_[A-Za-z0-9_-]{16,80}$/;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_HISTORY_MESSAGES = 12000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 160;
const HISTORY_SOURCE_LIMIT = 16 * 1024 * 1024;
const historyFailure = () => issue("historical_source_unavailable", "Conversation history is temporarily unavailable", 503);
const historyHash = value => createHash("sha256").update(value).digest("hex");
const privateHistoryEntry = (entry, directory = false) => (directory ? entry.isDirectory() : entry.isFile() && entry.nlink === 1n) &&
  (typeof process.getuid !== "function" || entry.uid === BigInt(process.getuid())) && (entry.mode & 0o077n) === 0n;
const sameHistoryEntry = (left, right) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => left[key] === right[key]);

// This reader never invokes the loading/recovery path or discovers a provider.
async function readPrivateHistory(root, branch, userId) {
  try {
    const directories = [];
    for (const path of [root, join(root, branch), join(root, branch, userId)]) {
      let entry;
      try { entry = await fs.lstat(path, { bigint: true }); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (!privateHistoryEntry(entry, true)) throw historyFailure();
      directories.push([path, entry]);
    }
    const path = join(root, branch, userId, "sessions.json");
    let file;
    try { file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let bytes;
    if (file) try {
      const before = await file.stat({ bigint: true });
      if (!privateHistoryEntry(before) || before.size > BigInt(HISTORY_SOURCE_LIMIT)) throw historyFailure();
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      if (!sameHistoryEntry(before, await file.stat({ bigint: true })) || !sameHistoryEntry(before, await fs.lstat(path, { bigint: true }))) throw historyFailure();
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
    for (const [path, before] of directories) {
      const after = await fs.lstat(path, { bigint: true });
      if (!privateHistoryEntry(after, true) || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode)
        throw historyFailure();
    }
    if (!bytes) return null;
    const data = JSON.parse(bytes.toString("utf8"));
    if (!data || Object.keys(data).sort().join(",") !== "sessions,version" || data.version !== 1 ||
        !Array.isArray(data.sessions) || data.sessions.length > 10000) throw historyFailure();
    return { sessions: data.sessions, revision: historyHash(bytes) };
  } catch { throw historyFailure(); }
}

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

async function writeRuntimePolicy(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, path);
    const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
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
    id: session.publicConversationId ?? session.id,
    title: session.title,
    directory: session.directory,
    parentID: session.publicParentId ?? session.parentId ?? null,
    time: { created: session.createdAt, updated: session.updatedAt },
    metadata: session.metadata ?? {},
    ...(session.model ? { model: session.model } : {}),
    variant: session.variant ?? null,
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
 * Legacy local-CLI mode copies its profile into private user state. Managed Web
 * mode delegates to the isolated runner without copying host credentials.
 * Native histories never share a directory with another user.
 */
export class CliRuntimeManager {
  #policyState; #policyDescription; #initializing; #policyStorageUncertain = false; #policyStopped = false;
  constructor({
    rootDir,
    runtime = "opencode",
    claudeCommand = "claude",
    claudeArgs = [],
    codexCommand = "codex",
    codexArgs = [],
    claudeConfigDir = join(homedir(), ".claude"),
    codexHome = join(homedir(), ".codex"),
    resourcesDir = null,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    spawnImpl = nodeSpawn,
    logger = () => {},
    profileResolver,
    sandboxJobs = null,
    assistantAuthority = null,
    onAnalyticsFact = null,
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
    this.assistantEnabled = { claude: false, codex: false };
    this.claudeCommand = claudeCommand;
    this.claudeArgs = [...claudeArgs];
    this.codexCommand = codexCommand;
    this.codexArgs = [...codexArgs];
    this.claudeConfigDir = resolve(claudeConfigDir);
    this.codexHome = resolve(codexHome);
    this.resourcesDir = resourcesDir;
    this.skillSeeds = new Map();
    this.profileResolver = profileResolver ?? new CliProfileResolver({ claudeConfigDir, codexHome });
    this.externalProfileResolver = Boolean(profileResolver);
    this.profiles = new Map();
    this.turnTimeoutMs = turnTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.sandboxJobs = sandboxJobs;
    this.assistantAuthority = assistantAuthority;
    this.onAnalyticsFact = onAnalyticsFact;
    this.nativeApprovals = new Map();
    this.nativeQuestions = new Map();
    this.logger = logger;
    this.userStates = new Map();
    this.userLoads = new Map();
    this.nativeConversationQueues = new Map();
    this.processes = new Map();
    this.turnReservations = new Map();
    this.activeTurns = new Set();
    this.subscribers = new Map();
    this.persistQueues = new Map();
    this.configPersistQueue = Promise.resolve();
    this.initialized = false;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return;
    this.#initializing ??= this.#initialize().catch(error => { this.#initializing = null; throw error; });
    return this.#initializing;
  }

  async #initialize() {
    await ensureDirectory(this.rootDir);
    await ensureDirectory(this.usersDir);
    if (!this.externalProfileResolver) {
      const keyPath = join(this.rootDir, "profile-revision-key");
      let key;
      try {
        key = await fs.readFile(keyPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { await fs.writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
        catch (createError) { if (createError.code !== "EEXIST") throw createError; }
        key = await fs.readFile(keyPath);
      }
      if (key.length !== 32) throw new Error("invalid private CLI revision key");
      this.profileResolver.revisionKey = key;
    }
    const configured = await readJson(this.configPath, undefined);
    if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured) ||
        !READABLE_RUNTIME_STORAGE_VERSIONS.includes(configured.version)))
      throw issue("unsupported_runtime_schema", "Runtime storage is not supported by this reader; existing data was preserved", 503);
    if ([2, 3, 4, 5].includes(configured?.version)) {
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
    } else if (configured?.version === 1) {
      this.defaultRuntime = "opencode";
    }
    this.#policyState = configured?.version === 5 ? structuredClone(configured.assistantPolicy) : {
      schema: 1, activeRuntime: this.defaultRuntime, revision: 1, transition: null, receipts: [], executions: {},
    };
    if (configured?.version === 5 && configured.defaultRuntime !== this.#policyState?.activeRuntime)
      throw issue("invalid_assistant_policy", "invalid assistant policy", 503);
    this.assistantPolicy = new AssistantPolicy({ state: this.#policyState,
      persist: state => this.persistRuntime(state),
      load: async () => {
        await this.configPersistQueue;
        const stored = await readJson(this.configPath);
        if (stored?.version !== 5 || stored.defaultRuntime !== stored.assistantPolicy?.activeRuntime)
          throw issue("invalid_assistant_policy", "invalid assistant policy", 503);
        const state = validateAssistantPolicyState(stored.assistantPolicy);
        this.#policyState = state;
        this.#policyStorageUncertain = false;
        return state;
      },
      prepare: async runtime => {
        if (MANAGED_RUNTIMES.has(runtime)) {
          const profile = await this.profileResolver.refresh(runtime);
          if (profile.status !== "ready" || !profile.enabledByProfile || !profile.models.length || !profile.defaultModel)
            throw issue("assistant_unavailable", "assistant is unavailable", 503);
        }
        if (typeof this.assistantAuthority?.prepare !== "function") throw issue("assistant_unavailable", "verified assistant authority is unavailable", 503);
        await this.assistantAuthority.prepare(runtime);
      },
      revoke: async input => {
        if (typeof this.assistantAuthority?.revoke !== "function") throw issue("assistant_recovery_required", "assistant revocation is unavailable", 503);
        await this.assistantAuthority.revoke(input);
      },
      inventory: async () => {
        const external = await this.assistantAuthority?.inventory?.() ?? { activeExecutions: [], uncertainEffects: [{ source: "unconfigured_authority" }] };
        return { ...external, activeExecutions: [...external.activeExecutions, ...this.turnReservations.keys(), ...this.activeTurns] };
      },
    });
    this.#applyPolicy(this.#policyState);
    await this.refreshProfiles();
    if (configured?.version !== 5) await this.persistRuntime(this.#policyState);
    await this.assistantPolicy.init();
    this.#policyDescription = await this.assistantPolicy.describe();
    this.#applyPolicy(this.#policyState);
    this.initialized = true;
  }

  #applyPolicy(state) {
    this.defaultRuntime = state.activeRuntime;
    this.assistantEnabled = { claude: state.activeRuntime === "claude", codex: state.activeRuntime === "codex" };
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

  async persistRuntime(policyState) {
    const next = this.configPersistQueue.then(async () => {
      if (this.#policyStopped || this.closed && policyState === undefined) throw issue("assistant_closed", "Assistant authority is closed", 503);
      if (this.#policyStorageUncertain || policyState === undefined && this.#policyDescription?.recoveryRequired)
        throw issue("assistant_recovery_required", "Assistant storage requires reconciliation", 503);
      const policy = validateAssistantPolicyState(policyState ?? this.#policyState);
      const snapshot = {
        version: RUNTIME_STORAGE_VERSION,
        defaultRuntime: policy.activeRuntime,
        userRuntimes: Object.fromEntries([...this.userRuntimes].sort(([a], [b]) => a.localeCompare(b))),
        userModels: Object.fromEntries(
          [...this.userModels]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([userId, choices]) => [userId, { ...choices }]),
        ),
        assistantEnabled: { claude: policy.activeRuntime === "claude", codex: policy.activeRuntime === "codex" },
        assistantPolicy: policy,
      };
      try { await writeRuntimePolicy(this.configPath, `${JSON.stringify(snapshot, null, 2)}\n`); }
      catch (error) { this.#policyStorageUncertain = true; throw error; }
      this.#policyState = policy;
      this.#applyPolicy(policy);
    });
    this.configPersistQueue = next.catch(() => {});
    await next;
  }

  runtimeForUser(userId) {
    assertUserId(userId);
    return this.defaultRuntime;
  }

  modelForUser(userId, runtime = this.runtimeForUser(userId)) {
    assertUserId(userId);
    if (!MANAGED_RUNTIMES.has(runtime)) return null;
    const config = this.managedRuntimes[runtime];
    const selected = this.userModels.get(userId)?.[runtime];
    return selected && config.models.includes(selected) ? selected : config.defaultModel;
  }

  async refreshProfiles() {
    for (const runtime of MANAGED_RUNTIMES) {
      const profile = await this.profileResolver.refresh(runtime);
      this.profiles.set(runtime, profile);
      this.managedRuntimes[runtime] = { models: profile.models.map((item) => item.id), defaultModel: profile.defaultModel };
    }
  }

  async setUserModel(userId, runtime, model) {
    await this.init();
    await this.refreshProfiles();
    assertUserId(userId);
    if (runtime !== this.runtimeForUser(userId)) throw issue("assistant_selection_admin_only", "Only an administrator can select the deployment assistant", 403);
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
    throw issue("assistant_selection_migrated", "Use revisioned administrator assistant selection", 409);
  }

  async setAssistantEnabled(runtime, enabled) {
    throw issue("assistant_selection_migrated", "Use revisioned administrator assistant selection", 409);
  }

  async selectAssistant(input) {
    if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
    await this.init();
    this.#policyDescription = { ...this.#policyDescription, recoveryRequired: true };
    try { return await this.assistantPolicy.select(input); }
    finally {
      this.#policyDescription = await this.assistantPolicy.describe();
      this.defaultRuntime = this.#policyDescription.activeRuntime;
      this.assistantEnabled = { claude: this.defaultRuntime === "claude", codex: this.defaultRuntime === "codex" };
    }
  }

  async reconcileAssistant() {
    if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
    await this.init();
    this.#policyDescription = { ...this.#policyDescription, recoveryRequired: true };
    try { return await this.assistantPolicy.reconcile(); }
    finally {
      this.#policyDescription = await this.assistantPolicy.describe();
      this.defaultRuntime = this.#policyDescription.activeRuntime;
      this.assistantEnabled = { claude: this.defaultRuntime === "claude", codex: this.defaultRuntime === "codex" };
    }
  }

  async setUserRuntime(userId, runtime, model) {
    await this.init();
    await this.refreshProfiles();
    assertUserId(userId);
    const selected = assertRuntime(runtime);
    const current = this.runtimeForUser(userId);
    if (selected !== current) throw issue("assistant_selection_admin_only", "Only an administrator can select the deployment assistant", 403);
    let selectedModel = null;
    if (MANAGED_RUNTIMES.has(selected)) {
      const config = this.managedRuntimes[selected];
      if (!this.assistantEnabled[selected] || config.models.length === 0 || !config.defaultModel) {
        throw issue("runtime_unconfigured", `${runtimeDescriptor(selected).label} has no administrator-enabled models`);
      }
      selectedModel = model === undefined ? this.modelForUser(userId, selected) : normalizeModelId(model);
      if (!config.models.includes(selectedModel)) {
        throw issue("model_not_enabled", `model ${selectedModel} is not enabled for ${selected}`);
      }
    }
    if (selectedModel && model !== undefined) {
      this.userModels.set(userId, { ...(this.userModels.get(userId) ?? {}), [selected]: selectedModel });
    }
    await this.persistRuntime();
    return this.describe(userId);
  }

  runtimeOption(runtime, userId = null, activeRuntime = this.defaultRuntime) {
    const descriptor = runtimeDescriptor(runtime);
    if (!MANAGED_RUNTIMES.has(runtime)) {
      return { ...descriptor, enabled: activeRuntime === runtime, models: [], defaultModel: null, selectedModel: null };
    }
    const config = this.managedRuntimes[runtime];
    return {
      ...descriptor,
      enabled: activeRuntime === runtime && config.models.length > 0 && Boolean(config.defaultModel),
      models: [...config.models],
      status: this.profiles.get(runtime)?.status ?? "unavailable",
      catalogRevision: this.profiles.get(runtime)?.catalogRevision ?? null,
      defaultModel: config.defaultModel,
      selectedModel: userId ? this.modelForUser(userId, runtime) : null,
    };
  }

  describe(userId, policy) {
    const selected = policy?.activeRuntime ?? this.runtimeForUser(userId);
    return {
      ...this.runtimeOption(selected, userId, selected),
      policyRevision: policy?.revision ?? this.#policyState?.revision,
      model: this.modelForUser(userId, selected),
      available: RUNTIME_ORDER.map((runtime) => this.runtimeOption(runtime, userId, selected)),
    };
  }

  async freshDescribe(userId) {
    await this.init();
    await this.refreshProfiles();
    return this.describe(userId, await this.assistantPolicy.describe());
  }
  assistantSnapshot(userId) {
    const state = this.#policyState;
    const ownedUnknown = Object.values(state?.executions ?? {}).some(execution => execution.status === "unknown" &&
      (userId === undefined || execution.identity.userId === userId));
    return { activeRuntime: state?.activeRuntime ?? this.defaultRuntime, revision: state?.revision ?? null,
      recoveryRequired: !this.initialized || this.closed || this.#policyStorageUncertain || !!state?.transition ||
        ownedUnknown || userId !== undefined && (typeof userId !== "string" || !USER_ID.test(userId)) };
  }

  async assertAssistantRevision(revision) {
    await this.init();
    const policy = this.assistantPolicy.committedSnapshot();
    if (this.closed || policy.recoveryRequired || this.#policyStorageUncertain)
      throw Object.assign(issue("assistant_recovery_required", "Assistant recovery is required", 503), { statusCode: 503 });
    if (revision !== String(policy.revision))
      throw Object.assign(issue("assistant_revision_conflict", "The deployment assistant changed; reload before continuing", 409), { statusCode: 409 });
    return policy;
  }
  async admitWorkspace({userId,revision},reserve) {
    const policy=await this.assertAssistantRevision(revision);
    return this.assistantPolicy.admitWorkspace({userId,policyRevision:policy.revision},reserve);
  }

  async admitHttpPrompt({conversations,owner,sessionId,requestId,policyRevision,body,readHandover}) {
    if(!this.sandboxJobs || typeof requestId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(requestId) ||
        typeof policyRevision!=="string" || !/^[1-9][0-9]*$/.test(policyRevision) || !body || typeof body!=="object" || Array.isArray(body))
      throw issue("invalid_execution_request","A valid execution request identity is required",400);
    owner=structuredClone(owner);body=structuredClone(body);
    const payloadHash=historyHash(JSON.stringify(body));
    const current=await conversations.open(owner,sessionId),previous=current.turns[requestId];
    // Existing receipts are read-only reconciliation, even after selection or
    // delivery became uncertain. They cannot refresh a profile or dispatch.
    if(previous) {
      const admitted=await this.admitConversation({conversations,owner,conversationId:sessionId,expectedRevision:current.revision,
        request:{requestId,payloadHash,policyRevision:Number(policyRevision),runtime:previous.identity.runtime,
          generation:owner.generation,model:previous.model,identityRevision:previous.identityRevision}});
      return {...admitted,model:previous.model,identityRevision:previous.identityRevision};
    }
    const policy=await this.assertAssistantRevision(policyRevision);
    const {state,session}=await this.getOwnedSession(owner.userId,sessionId);
    if(session.runtime!==policy.activeRuntime || session.directory!==owner.directory || current.directory!==owner.directory)
      throw issue("conversation_handover_required","The conversation requires assistant handover",409);
    if(session.status==="running" || this.turnReservations.has(session.id))throw issue("session_busy","session is already running",409);
    // Reuse the existing reservation so Stop also owns profile refresh and
    // attachment/research preparation, before a native process exists.
    const reservation={userId:owner.userId,state,session,cancelled:false};
    this.turnReservations.set(session.id,reservation);
    try {
    const profile=await this.profileResolver.refresh(session.runtime);
    if(!profile.enabledByProfile || !this.assistantEnabled[session.runtime])throw issue("runtime_unconfigured","AI assistant is unavailable",503);
    if(body.model!==undefined && (body.model?.providerID!==session.runtime || typeof body.model.modelID!=="string"))
      throw issue("invalid_model","model belongs to another AI assistant",400);
    const model=body.model?.modelID ?? this.modelForUser(owner.userId,session.runtime) ?? profile.defaultModel;
    const selected=profile.models.find(item=>item.id===model);
    if(!selected)throw issue("model_not_enabled","model is unavailable",400);
    if(body.variant!==undefined && body.variant!==null && (typeof body.variant!=="string" || !Object.hasOwn(selected.variants??{},body.variant)))
      throw issue("invalid_variant","reasoning variant is unavailable for this model",400);
    if(reservation.cancelled)throw issue("turn_cancelled","Turn was cancelled",409);
    const binding=current.bindings.find(binding=>binding.id===current.currentBindingId);
    if(typeof readHandover!=='function'&&current.sequence!==0)throw issue('conversation_history_unavailable','Owned canonical history is required',503);
    const context=typeof readHandover==='function'?await readHandover(structuredClone(current)):{history:[],decisions:[],attachments:[]};
    if(!context||!Array.isArray(context.history)||context.history.length!==current.events.length||
      context.history.some((message,index)=>message.info?.id!==current.events[index].publicMessageId||message.info.role!==current.events[index].role)||
      !Array.isArray(context.decisions)||!Array.isArray(context.attachments))throw issue('conversation_history_changed','Owned canonical history changed',409);
    if(reservation.cancelled)throw issue("turn_cancelled","Turn was cancelled",409);
    if((await conversations.open(owner,sessionId)).revision!==current.revision)throw issue('conversation_revision_conflict','Conversation changed during handover',409);
    const projection=await this.conversationRevert?.projection(owner,sessionId)??{version:0,hiddenMessageIds:[]};
    const hidden=new Set(projection.hiddenMessageIds),sameProjection=(session.revertVersion??0)===projection.version;
    const handover=prepareHandover({conversation:current,binding:sameProjection&&binding?.nativeSessionId===session.nativeSessionId?binding:null,
      profile:{runtime:session.runtime,identityRevision:profile.identityRevision},history:context.history.filter(message=>!hidden.has(message.info.id)),
      decisions:context.decisions,attachments:context.attachments});
    const admitted=await this.admitConversation({conversations,owner,conversationId:sessionId,expectedRevision:current.revision,
      representedSequence:handover.representedSequence,
      request:{requestId,payloadHash,policyRevision:policy.revision,runtime:session.runtime,generation:owner.generation,
        model,identityRevision:profile.identityRevision}});
    if(reservation.cancelled){await admitted.settle({cleanupVerified:true});throw issue("turn_cancelled","Turn was cancelled",409);}
    const result={...admitted,model,identityRevision:profile.identityRevision,reservation,handover,revertVersion:projection.version,owner:structuredClone(owner),
      settle:async options=>{
        try{return await admitted.settle(options);}
        finally{if(this.turnReservations.get(session.id)===reservation)this.turnReservations.delete(session.id);}
      }};
    reservation.executionAdmission=result;return result;
    }catch(error){if(this.turnReservations.get(session.id)===reservation)this.turnReservations.delete(session.id);throw error;}
  }

  async admitConversation({ conversations, owner, conversationId, expectedRevision, request,representedSequence=0 }) {
    await this.init();
    if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
    if (!conversations || typeof conversations.previewTurn !== "function") throw issue("assistant_unavailable", "Conversation authority is unavailable", 503);
    const capturedOwner = structuredClone(owner), capturedInput = structuredClone({ ...request, expectedRevision });
    const preview = await conversations.previewTurn(capturedOwner, conversationId, capturedInput);
    // Recovering an existing receipt is a read. It never grants dispatch or a
    // new lease, including when an earlier delivery has an uncertain result.
    if (preview.replay) return { replay: true, receipt: preview.receipt, identity: preview.receipt.identity };
    if (this.#policyStorageUncertain) throw issue("assistant_recovery_required", "Assistant selection requires reconciliation", 503);
    const lease = await this.assistantPolicy.admit(preview.receipt.identity, async () => {
      if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
      const receipt = await conversations.prepareTurn(capturedOwner, conversationId, capturedInput);
      if (JSON.stringify(receipt.identity) !== JSON.stringify(preview.receipt.identity))
        throw issue("assistant_identity_conflict", "Conversation execution identity changed", 503);
      return receipt;
    });
    let transitionQueue = Promise.resolve(),acceptedBindingId;
    const serial = run => {
      const next = transitionQueue.catch(() => {}).then(run); transitionQueue = next; return next;
    };
    const transition = async (state, extra = {}) => {
      if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
      const current = await conversations.open(capturedOwner, conversationId), receipt = current.turns[capturedInput.requestId];
      if (!receipt || JSON.stringify(receipt.identity) !== JSON.stringify(lease.reservation.identity))
        throw issue("assistant_identity_conflict", "Conversation execution identity changed", 503);
      if (receipt.state === state) {
        if (extra.nativeAcceptance && JSON.stringify(extra.nativeAcceptance) !== JSON.stringify(receipt.nativeAcceptance))
          throw issue("assistant_identity_conflict", "Native acceptance identity changed", 503);
        return receipt;
      }
      return conversations.advanceTurn(capturedOwner, conversationId, {
        requestId: capturedInput.requestId, expectedRevision: current.revision, state, ...extra,
      });
    };
    return { replay: false, identity: structuredClone(lease.reservation.identity), receipt: structuredClone(lease.reservation),
      publicMessageId:messageId=>{
        if(!acceptedBindingId)throw issue('native_acceptance_required','Native acceptance is required for message identity',503);
        return nativePublicMessageId(conversationId,acceptedBindingId,messageId);
      },
      submitted: () => serial(() => transition("submitted")),
      accepted: nativeAcceptance => {
        const capturedAcceptance = structuredClone(nativeAcceptance);
        return serial(() => transition("accepted", { nativeAcceptance: capturedAcceptance }));
      },
      acceptedNative: nativeAcceptance => {
        const capturedAcceptance=structuredClone(nativeAcceptance);
        return serial(async()=>{
          if(this.closed)throw issue("assistant_closed","Assistant authority is closed",503);
          const current=await conversations.open(capturedOwner,conversationId),receipt=current.turns[capturedInput.requestId];
          if(!receipt || JSON.stringify(receipt.identity)!==JSON.stringify(lease.reservation.identity) ||
              !this.assistantPolicy.isExecutionCurrent(receipt.identity))throw issue("assistant_identity_conflict","Native admission changed",503);
          const accepted=await conversations.acceptNativeTurn(capturedOwner,conversationId,{requestId:capturedInput.requestId,
            expectedRevision:current.revision,nativeAcceptance:capturedAcceptance,representedSequence});
          const bound=await conversations.open(capturedOwner,conversationId);
          const binding=bound.bindings.find(value=>value.id===bound.currentBindingId);
          if(!binding||binding.runtime!==capturedAcceptance.runtime||binding.nativeSessionId!==capturedAcceptance.nativeSessionId||binding.identityRevision!==capturedInput.identityRevision)
            throw issue('native_identity_conflict','Native binding changed after acceptance',503);
          acceptedBindingId=binding.id;return accepted;
        });
      },
      settle: ({ cleanupVerified } = {}) => serial(async () => {
        await transition(cleanupVerified === true ? "settled" : "unknown", cleanupVerified === true ? { cleanupVerified: true } : {});
        await lease.settle({ cleanupVerified: cleanupVerified === true });
      }),
    };
  }

  async freshAdminDescribe(operationId) {
    await this.init();
    await this.refreshProfiles();
    return this.adminDescribe(await this.assistantPolicy.describe(operationId));
  }

  adminDescribe(policy = this.#policyDescription ?? { activeRuntime: this.defaultRuntime, revision: this.#policyState?.revision, recoveryRequired: true }) {
    return {
      ...policy,
      defaultRuntime: policy.activeRuntime,
      available: RUNTIME_ORDER.map((runtime) => this.runtimeOption(runtime, null, policy.activeRuntime)),
      assistantEnabled: { claude: policy.activeRuntime === "claude", codex: policy.activeRuntime === "codex" },
    };
  }

  isManaged(userId) {
    return this.runtimeForUser(userId) !== "opencode";
  }

  userPaths(userId) {
    assertUserId(userId);
    const nativeRoot = join(this.usersDir, userId);
    const root = this.sandboxJobs ? join(this.rootDir,"metadata",userId) : nativeRoot;
    return {
      root,
      sessionsPath: join(root, "sessions.json"),
      home: join(nativeRoot, "home"),
      claudeConfig: join(nativeRoot, "claude-config"),
      codexHome: join(nativeRoot, "codex-home"),
    };
  }

  #historicalSources({ userId, workspaceDir }) {
    assertUserId(userId);
    return this.#withUserStorage(userId, () => this.#readHistoricalSources({userId, workspaceDir}));
  }

  async #readHistoricalSources({ userId, workspaceDir }) {
    assertUserId(userId);
    if (typeof workspaceDir !== "string" || !isAbsolute(workspaceDir) || resolve(workspaceDir) !== workspaceDir) throw historyFailure();
    const sessions = new Map(), revisions = [];
    const legacyWorkspace = join(dirname(this.rootDir), "workers", "instances", `user-${userId}`, "workspace");
    for (const branch of this.sandboxJobs ? ["metadata", "users"] : ["users"]) {
      const source = await readPrivateHistory(this.rootDir, branch, userId);
      revisions.push([branch, source?.revision ?? null]);
      if (!source) continue;
      for (const session of source.sessions) {
        if (this.sandboxJobs && branch === "users" && typeof session?.directory === "string" &&
            resolve(session.directory) === session.directory && isWithin(legacyWorkspace, session.directory)) {
          session.directory = join(workspaceDir, relative(legacyWorkspace, session.directory));
        }
        if (!session || session.userId !== userId || !SESSION_ID.test(session.id) || !MANAGED_RUNTIMES.has(session.runtime) ||
            typeof session.directory !== "string" || resolve(session.directory) !== session.directory || !isWithin(workspaceDir, session.directory) ||
            typeof session.title !== "string" || session.title.length > 512 || !Array.isArray(session.history) || session.history.length > 12000 ||
            session.parentId !== undefined && (!SESSION_ID.test(session.parentId) || session.parentId === session.id)) throw historyFailure();
        const messages = new Set();
        if(session.bindingHistory!==undefined&&(!Array.isArray(session.bindingHistory)||session.bindingHistory.length>128||
          session.bindingHistory.some(binding=>!binding||typeof binding.nativeSessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(binding.nativeSessionId)||
            typeof binding.identityRevision!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(binding.identityRevision))))throw historyFailure();
        if(session.publicConversationId!==undefined&&(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(session.publicConversationId)||session.publicConversationId===session.id)||
          session.publicParentId!==undefined&&(!session.parentId||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(session.publicParentId)))throw historyFailure();
        for (const message of session.history) {
          if (!message || typeof message.info?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.info.id) ||
              messages.has(message.info.id) || !["user", "assistant"].includes(message.info.role) || !Array.isArray(message.parts) ||
              message.parts.length > 10000) throw historyFailure();
          messages.add(message.info.id);
        }
        if (sessions.has(session.id)) throw issue("historical_source_conflict", "Conversation history has conflicting origins", 503);
        sessions.set(session.id, session);
      }
    }
    for (const session of sessions.values()) {
      const visited = new Set(); let current = session;
      while (current) {
        if (visited.has(current.id) || visited.size >= 20 || current.directory !== session.directory) throw historyFailure();
        visited.add(current.id);
        if (!current.parentId) break;
        current = sessions.get(current.parentId); if (!current) throw historyFailure();
      }
      if (session.history.some(message => message.info.sessionID !== undefined && !visited.has(message.info.sessionID))) throw historyFailure();
    }
    return { sessions, revision: historyHash(JSON.stringify([userId, workspaceDir, revisions])) };
  }

  async readHistoricalSessions(input) {
    const { sessions } = await this.#historicalSources(input), visible = [];
    for (const session of sessions.values()) {
      let lifecycle = session.metadata?.archived ? "archived" : "active";
      try { await this.workspaceAccess?.(input.userId, session.directory); }
      catch (error) { if (error.code !== "project_trashed") throw error; lifecycle = "trashed"; }
      visible.push({ ...publicSession(session), runtime: session.runtime, lifecycle,
        id:session.id,parentID:session.parentId??null,publicConversationId:session.publicConversationId,
        permission:structuredClone(session.permission??[]),
        nativeSessionId: session.nativeSessionId ?? null, identityRevision: session.identityRevision ?? null,
        bindingHistory:structuredClone(session.bindingHistory??[]) });
    }
    return visible;
  }

  async readHistoricalMessages({ userId, workspaceDir, sessionId, cursor = null, limit = 200 }) {
    assertSessionId(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw issue("invalid_history_limit", "Invalid history page size");
    const { sessions, revision } = await this.#historicalSources({ userId, workspaceDir });
    const session = sessions.get(sessionId); if (!session) throw issue("unknown_session", "Conversation not found", 404);
    await this.workspaceAccess?.(userId, session.directory);
    const identity = historyHash(JSON.stringify([revision, sessionId])); let offset = 0;
    if (cursor !== null) {
      const parsed = typeof cursor === "string" && cursor.match(/^history_([a-f0-9]{64})_([0-9]{1,5})$/);
      if (!parsed || parsed[1] !== identity || Number(parsed[2]) > session.history.length) throw issue("historical_cursor_changed", "Conversation changed; restart history indexing", 409);
      offset = Number(parsed[2]);
    }
    const end = Math.min(offset + limit, session.history.length);
    // Older native writers generated an unrelated UUID for user text parts.
    // Repair that exact presentation shape in the owned view, preserving disk bytes.
    const messages=session.history.slice(offset,end).map(message=>message.info.role==='user'?{...message,parts:message.parts.map(part=>
      part.type==='text'&&part.sessionID===message.info.sessionID&&
      /^msg_cli_user_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(part.messageID??'')?
        {...part,messageID:message.info.id}:part)}:message);
    return structuredClone({ session: { ...publicSession(session), id:session.id,runtime: session.runtime, nativeSessionId: session.nativeSessionId ?? null,
      identityRevision: session.identityRevision ?? null }, messages,
      nextCursor: end < session.history.length ? `history_${identity}_${end}` : null, sourceRevision: identity });
  }

  async ensureUser(userId) {
    await this.init();
    const existing = this.userStates.get(userId);
    if (existing) return existing;
    const loading=this.userLoads.get(userId);if(loading)return loading;
    const pending=this.#loadUser(userId);this.userLoads.set(userId,pending);
    try{return await pending;}finally{if(this.userLoads.get(userId)===pending)this.userLoads.delete(userId);}
  }

  async #loadUser(userId) {
    const paths = this.userPaths(userId);
    await ensureDirectory(paths.root);
    if(!this.sandboxJobs)await ensureDirectory(paths.home);
    const loaded = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
    const sessions = new Map();
    for (const session of Array.isArray(loaded?.sessions) ? loaded.sessions : []) {
      if (!session || session.userId !== userId || !SESSION_ID.test(session.id)) continue;
      if (typeof session.directory !== "string" || typeof session.title !== "string") continue;
      sessions.set(session.id, {
        ...Object.fromEntries(Object.entries(session).filter(([key]) => !key.startsWith("_"))),
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
      sessions: [...state.sessions.values()].map((session) => Object.fromEntries(Object.entries(session)
        .filter(([key]) => key !== "status" && !key.startsWith("_")))),
    };
    await this.#withUserStorage(state.userId, () => writePrivate(state.paths.sessionsPath, `${JSON.stringify(snapshot, null, 2)}\n`));
  }

  #withUserStorage(userId, operation) {
    const previous = this.persistQueues.get(userId) ?? Promise.resolve();
    const next = previous.then(operation);
    this.persistQueues.set(userId, next.then(() => undefined, () => undefined));
    return next;
  }

  async ensureSkills(state) {
    if (!this.skillSeeds.has(state.userId)) {
      const seed = seedSkills(state.paths.home, this.resourcesDir).catch((error) => {
        this.skillSeeds.delete(state.userId);
        throw error;
      });
      this.skillSeeds.set(state.userId, seed);
    }
    return this.skillSeeds.get(state.userId);
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

  childEnvironment(state, runtime, pinned) {
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
      env.CLAUDE_CONFIG_DIR = pinned?.configDir ?? state.paths.claudeConfig;
      env.ANTHROPIC_CONFIG_DIR = pinned?.configDir ?? state.paths.claudeConfig;
    }
    if (runtime === "codex") {
      env.CODEX_HOME = pinned?.codexHome ?? state.paths.codexHome;
      Object.assign(env, pinned?.env ?? {});
    }
    return env;
  }

  commandFor(state, session, text, nativeSessionId = session.nativeSessionId, attachmentInput) {
    const runtime = session.runtime;
    const model = session.model ?? this.modelForUser(session.userId, runtime);
    if (!model) {
      throw issue("runtime_unconfigured", `${runtimeDescriptor(runtime).label} has no administrator-enabled models`);
    }
    if (runtime === "claude") {
      const args = [
        ...this.claudeArgs,
        "-p",
        ...(attachmentInput?.images?.length ? ["--input-format", "stream-json"] : [text]),
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
      if (attachmentInput?.files?.length) args.push("--add-dir", ...new Set(attachmentInput.files.map((f) => f.workDir)));
      if (session.variant) args.push("--effort", session.variant);
      if (nativeSessionId) args.push("--resume", nativeSessionId);
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
      ...(session.variant ? ["-c", `model_reasoning_effort=${JSON.stringify(session.variant)}`] : []),
      ...(attachmentInput?.files?.length ? [...new Set(attachmentInput.files.map((f) => f.workDir))].flatMap((dir) => ["--add-dir", dir]) : []),
      ...(nativeSessionId ? ["resume", nativeSessionId] : []),
      ...codexImageArgs((attachmentInput?.images ?? []).map((image) => image.path)),
      ...(attachmentInput?.images?.length ? ["--"] : []),
      text,
    ];
    return { command: this.codexCommand, args };
  }

  async createSession({ userId, workspaceDir, directory = workspaceDir, title = "New session" }) {
    const state = await this.ensureUser(userId);
    await this.refreshProfiles();
    const runtime = this.runtimeForUser(userId);
    if (runtime === "opencode") {
      throw issue("unmanaged_runtime", "OpenCode sessions are handled by the user's worker", 409);
    }
    const safeDirectory = resolve(directory);
    if (!isWithin(workspaceDir, safeDirectory)) throw issue("invalid_directory", "session directory is outside the user workspace", 403);
    await this.workspaceAccess?.(userId,safeDirectory);
    const timestamp = now();
    const id = `ses_cli_${randomUUID().replaceAll("-", "")}`;
    const session = {
      id,
      userId,
      runtime,
      model: managedModelKey(runtime, this.modelForUser(userId, runtime)),
      variant: null,
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
    if(typeof sessionId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(sessionId))throw issue("invalid_session","invalid session id",400);
    const matches=[...state.sessions.values()].filter(session=>(session.publicConversationId??session.id)===sessionId&&session.runtime===this.runtimeForUser(userId));
    if(matches.length>1)throw issue("conversation_origin_conflict","Conversation has conflicting native aliases",503);
    const session=matches[0];
    if (!session) {
      throw issue("unknown_session", "session not found in the selected runtime", 404);
    }
    await this.workspaceAccess?.(userId,session.directory);
    return { state, session };
  }

  async ensureNativeConversation(input) {
    const userId=input.owner.userId,previous=this.nativeConversationQueues.get(userId)??Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>this.#ensureNativeConversation(input));
    this.nativeConversationQueues.set(userId,next);
    try{return await next;}finally{if(this.nativeConversationQueues.get(userId)===next)this.nativeConversationQueues.delete(userId);}
  }

  async #ensureNativeConversation({conversations,owner,conversationId,readDenies}) {
    if(!this.sandboxJobs||!this.isManaged(owner.userId))throw issue('runtime_unavailable','Native conversation is unavailable',503);
    const state=await this.ensureUser(owner.userId),runtime=this.runtimeForUser(owner.userId),chain=[];
    let id=conversationId;
    while(id){
      if(chain.some(value=>value.id===id)||chain.length>=20)throw historyFailure();
      const value=await conversations.open(owner,id);
      if(value.directory!==owner.directory||value.turns&&Object.values(value.turns).some(turn=>turn.state!=='settled'||turn.cleanupVerified!==true))
        throw issue('assistant_recovery_required','Conversation cleanup requires reconciliation',503);
      await this.workspaceAccess?.(owner.userId,value.directory);chain.push(value);id=value.parentId;
    }
    let parent;
    for(const value of chain.reverse()){
      const candidates=[...state.sessions.values()].filter(session=>(session.publicConversationId??session.id)===value.id&&session.runtime===runtime);
      if(candidates.length>1)throw historyFailure();
      let session=candidates[0];
      if(!session){
        const prior=state.sessions.get(value.id);
        if(value.historicalSource&&!readDenies)throw issue('conversation_permissions_unavailable','Owned source permissions are required',503);
        const permission=readDenies?await readDenies(value.id):structuredClone(prior?.permission??[]).filter(rule=>rule.action==='deny');
        if(!Array.isArray(permission)||permission.length>256||permission.some(rule=>!rule||rule.action!=='deny'||
          Object.keys(rule).sort().join(',')!=='action,pattern,permission'||[rule.permission,rule.pattern].some(value=>typeof value!=='string'||!value||value.length>4096||value.includes('\0'))))throw historyFailure();
        const timestamp=now();session={id:`ses_cli_${randomUUID().replaceAll('-','')}`,publicConversationId:value.id,
          ...(parent?{parentId:parent.id,publicParentId:value.parentId}:{}),userId:owner.userId,runtime,directory:value.directory,
          title:value.title,model:managedModelKey(runtime,this.modelForUser(owner.userId,runtime)),variant:null,nativeSessionId:null,
          createdAt:timestamp,updatedAt:timestamp,metadata:{},history:[],status:'idle',
          permission:structuredClone(permission)};
        state.sessions.set(session.id,session);
      }
      if(session.directory!==value.directory)throw historyFailure();parent=session;
    }
    await this.persistUser(state);return parent;
  }

  // Internal research operations share native session storage. This is not an
  // inference endpoint and cannot dispatch a prompt or select another runtime.
  async researchRequest({ userId, directory, path, method = "GET", body }) {
    if (!this.isManaged(userId) || typeof directory !== "string" || resolve(directory) !== directory)
      throw issue("invalid_research_context", "Native research context is unavailable", 403);
    const match = typeof path === "string" && path.match(/^\/session\/([A-Za-z0-9_-]+)(?:\/(message|children|abort))?$/);
    if (!match) throw issue("invalid_research_operation", "Unsupported native research operation", 400);
    const sessionId = match[1], operation = match[2] ?? "session";
    if (!(method === "GET" && ["session", "message", "children"].includes(operation) ||
      method === "PATCH" && operation === "session" || method === "POST" && operation === "abort"))
      throw issue("invalid_research_operation", "Unsupported native research operation", 400);
    const input = body === undefined ? undefined : structuredClone(body);
    const { state, session } = await this.getOwnedSession(userId, sessionId);
    if (session.directory !== directory)
      throw issue("invalid_research_context", "Native research directory changed", 403);
    if (method === "PATCH") {
      const validRules = rules => Array.isArray(rules) && rules.length <= 256 && rules.every(rule =>
        rule && typeof rule === "object" && Object.keys(rule).sort().join(",") === "action,pattern,permission" &&
        ["allow", "ask", "deny"].includes(rule.action) && [rule.permission, rule.pattern].every(value =>
          typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")));
      if (!input || Object.keys(input).join(",") !== "permission" || !validRules(input.permission) || !validRules(session.permission ?? []))
        throw issue("invalid_research_permissions", "Invalid native research permissions", 400);
      // Keep platform rules separate from explicit session rules. Applying the
      // next execution's policy must neither erase nor reclassify explicit denies.
      if (input.permission.length + (session.permission ?? []).length > 256)
        throw issue("invalid_research_permissions", "Too many native research permissions", 400);
      session.researchPermission = input.permission;
      session.updatedAt = now();
      await this.persistUser(state);
    }
    if (operation === "abort") { await this.abortSession(userId, sessionId); return true; }
    if (operation === "message") return structuredClone(session.history);
    if (operation === "children") {
      const children = [];
      for (const child of state.sessions.values()) if (child.parentId === session.id && child.runtime === session.runtime) {
        await this.workspaceAccess?.(userId, child.directory);
        children.push(publicSession(child));
      }
      return children;
    }
    return { ...publicSession(session), permission: structuredClone([...(session.researchPermission ?? []), ...(session.permission ?? [])]) };
  }

  async listSessions({ userId, search = "", limit = 200 }) {
    const state = await this.ensureUser(userId);
    const runtime = this.runtimeForUser(userId);
    const query = typeof search === "string" ? search.trim().toLowerCase() : "";
    const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const visible=[];
    for(const session of state.sessions.values()) {
      if(session.runtime!==runtime)continue;
      try{await this.workspaceAccess?.(userId,session.directory);visible.push(session);}catch(error){if(error.code!=="project_trashed")throw error;}
    }
    return visible
      .filter((session) => session.runtime === runtime)
      .filter((session) => !query || session.title.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max)
      .map(publicSession);
  }

  emit(userId,event) {
    const id=event.properties?.sessionID??event.properties?.info?.sessionID??event.properties?.part?.sessionID;
    const sessions=this.userStates.get(userId)?.sessions;
    const session=id?sessions?.get(id)??[...sessions?.values()??[]].find(value=>value.publicConversationId===id):null;
    if(id&&!session)return;
    const context=session&&this.turnReservations.get(session.id)?.workspaceContext;
    if(this.onAnalyticsFact&&session&&context?.userId===userId&&typeof context.instanceId==='string'&&Number.isSafeInteger(context.generation)){
      const scope={accountId:userId,runtime:session.runtime,instanceId:context.instanceId,generation:context.generation};
      const metadataEvent={...event,properties:{...event.properties,...(event.properties?.sessionID?{sessionID:session.id}:{})}};
      for(const fact of metadataFacts(metadataEvent)){
        try{this.onAnalyticsFact(scope,fact);}catch{/* Optional metadata must not affect execution. */}
      }
    }
    if(session){
      const properties={...event.properties},publicId=session.publicConversationId??session.id;
      if(properties.sessionID!==undefined)properties.sessionID=publicId;
      if(properties.info)properties.info={...properties.info,sessionID:publicId,id:session._publicMessageId?.(properties.info.id)??properties.info.id};
      if(properties.part)properties.part={...properties.part,sessionID:publicId,messageID:session._publicMessageId?.(properties.part.messageID)??properties.part.messageID};
      event={...event,properties};
    }
    if(!this.workspaceAccess)return this.emitVisible(userId,event);
    if(!session)return this.emitVisible(userId,event);
    void this.workspaceAccess(userId,session.directory).then(()=>this.emitVisible(userId,event)).catch(()=>{});
  }
  emitVisible(userId, event) {
    const subscribers = this.subscribers.get(userId);
    if (!subscribers) return;
    const sessionId = event.properties?.sessionID??event.properties?.info?.sessionID??event.properties?.part?.sessionID;
    const sessions=this.userStates.get(userId)?.sessions;
    const session = sessionId ? sessions?.get(sessionId)??[...sessions?.values()??[]].find(value=>value.publicConversationId===sessionId) : null;
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

  async reservePrompt({ userId, sessionId, text, displayText, model, variant, attachmentInput, workspaceContext, executionAdmission }) {
    await this.init();
    if (this.closed) throw issue("assistant_closed", "Assistant authority is closed", 503);
    if (this.#policyStorageUncertain || this.#policyDescription?.recoveryRequired || this.#policyState.transition)
      throw issue("assistant_recovery_required", "Assistant selection requires reconciliation", 503);
    const { state, session } = await this.getOwnedSession(userId, sessionId);
    const reserved=this.turnReservations.get(session.id);
    if (session.status === "running" || reserved && reserved!==executionAdmission?.reservation) throw issue("session_busy", "session is already running", 409);
    if(reserved?.cancelled)throw issue("turn_cancelled","Turn was cancelled",409);
    if (typeof text !== "string" || !text.trim()) throw issue("empty_prompt", "prompt is empty");
    if(session.history.length>MAX_HISTORY_MESSAGES-2 || this.sandboxJobs &&
        Buffer.byteLength(JSON.stringify([...state.sessions.values()],null,2))+Buffer.byteLength(text)>HISTORY_SOURCE_LIMIT-6*1024**2)
      throw issue("conversation_history_full","Conversation history is full; existing messages have been preserved",507);
    if(executionAdmission && (executionAdmission.replay || executionAdmission.identity.userId!==userId ||
        executionAdmission.identity.conversationId!==(session.publicConversationId??session.id) || !this.assistantPolicy.isExecutionCurrent(executionAdmission.identity)))
      throw issue("assistant_identity_conflict","Execution admission is no longer current",409);
    const turn = Object.assign(reserved??{}, { userId, state, session, text, displayText, model, attachmentInput, workspaceContext, executionAdmission, cancelled: false });
    this.turnReservations.set(session.id, turn);
    session.status = "running";
    delete session._pendingNativeSessionId;
    delete session._error;
    delete session._turnFailed;
    try {
    if (!this.assistantEnabled[session.runtime]) throw issue("runtime_unconfigured", "AI assistant is unavailable");
    const profile = await this.profileResolver.refresh(session.runtime);
    this.profiles.set(session.runtime, profile);
    this.managedRuntimes[session.runtime] = { models: profile.models.map((item) => item.id), defaultModel: profile.defaultModel };
    if (!this.assistantEnabled[session.runtime] || !profile.enabledByProfile) throw issue("runtime_unconfigured", "AI assistant is unavailable");
    const previousModel = session.model ? modelFromManagedKey(session.runtime, session.model) : this.modelForUser(userId, session.runtime);
    const selected = model ?? previousModel;
    if (model !== undefined && !profile.models.some((item) => item.id === model)) throw issue("model_not_enabled", "model is unavailable", 400);
    const chosen = profile.models.some((item) => item.id === selected) ? selected : profile.defaultModel;
    if (!chosen) throw issue("model_not_enabled", "model is unavailable", 400);
    const selectedModel = profile.models.find((item) => item.id === chosen);
    if (attachmentInput?.images?.length && selectedModel?.inputModalities && !selectedModel.inputModalities.includes("image")) {
      throw issue("image_model_unsupported", "This model cannot read images. Select a model with image support, or remove the image attachments.", 400);
    }
    const variants = profile.models.find((item) => item.id === chosen)?.variants ?? {};
    if (variant !== undefined && variant !== null && (typeof variant !== "string" || !Object.hasOwn(variants, variant))) {
      throw issue("invalid_variant", "reasoning variant is unavailable for this model", 400);
    }
    // Match OpenCode's per-turn contract: omission uses the model default.
    const chosenVariant = variant ?? null;
    if(executionAdmission && (executionAdmission.identityRevision!==profile.identityRevision || executionAdmission.model!==chosen))
      throw issue("assistant_identity_conflict","The admitted model profile changed",409);
    if (turn.cancelled) throw issue("turn_cancelled", "turn was cancelled", 409);
    return Object.assign(turn, { profile, chosen, chosenVariant });
    } catch (error) {
      if (this.turnReservations.get(session.id) === turn) this.turnReservations.delete(session.id);
      session.status = "idle";
      throw error;
    }
  }

  async sendPrompt(args) {
    return this.runReservedPrompt(await this.reservePrompt(args));
  }

  async runReservedPrompt(turn) {
    const pending=this.executeReservedPrompt(turn);this.activeTurns.add(pending);
    let completed=false;
    try{const result=await pending;completed=true;return result;}
    finally{
      try{if(turn.executionAdmission)await turn.executionAdmission.settle({cleanupVerified:completed &&
        (!turn.executionAdmission.dispatched || turn.nativeCleanupVerified===true)});}
      finally{this.activeTurns.delete(pending);}
    }
  }

  async executeReservedPrompt(turn) {
    try {
      await this.startReservedPrompt(turn);
    } catch (error) {
      const { userId, state, session } = turn;
      if (this.turnReservations.get(session.id) === turn) {
        const message = error.code === "turn_cancelled" ? "Turn was cancelled."
          : "AI assistant could not start this turn. Retry with the current model catalog.";
        const failure = { name: "CliRuntimeError", data: { message } };
        delete session._pendingNativeSessionId;
        delete session._error;
        delete session._turnFailed;
        delete session._redact;
        session.status = "idle";
        this.turnReservations.delete(session.id);
        this.emit(userId, { type: "session.error", properties: { sessionID: session.id, error: failure } });
        this.emit(userId, { type: "session.idle", properties: { sessionID: session.id } });
        await this.persistUser(state);
      }
      throw error;
    }
  }

  async startSandboxPrompt(turn) {
    const {userId,state,session,text,displayText,chosen,chosenVariant,profile,attachmentInput}=turn;
    if(session.runtime!=="codex")throw issue("runtime_unavailable","sandbox native runtime unavailable",503);
    const controller=new AbortController();this.processes.set(session.id,controller);
    if(turn.cancelled)controller.abort();
    const timestamp=now(),userMessageId=attachmentInput?.turn?.messageID??`msg_cli_user_${randomUUID()}`;
    const userMessage={info:{id:userMessageId,role:"user",sessionID:session.id,
      time:{created:timestamp,completed:timestamp}},parts:[textPart(displayText??text,userMessageId,session.id)],
      ...(attachmentInput?{attachments:attachmentInput.metadata}:{})};
    session.history.push(userMessage);await this.persistUser(state);
    const assistant={info:{id:`msg_cli_${randomUUID()}`,role:"assistant",sessionID:session.id,parentID:userMessageId,
      providerID:session.runtime,modelID:chosen,time:{created:timestamp}},parts:[]};
    const stale=Boolean(session.nativeSessionId && session.identityRevision!==profile.identityRevision);
    let acceptedNativeSessionId,captured=false;
    const revertOwner=turn.executionAdmission?.owner??(turn.workspaceContext&&{...turn.workspaceContext,userId,directory:session.directory});
    const revertInput=turn.executionAdmission&&{conversationId:turn.executionAdmission.identity.conversationId,requestId:turn.executionAdmission.identity.requestId};
    try {
      if(this.conversationRevert&&revertOwner&&revertInput){
        const result=await this.conversationRevert.begin(revertOwner,revertInput);captured=result?.captured===true;
      }
      if(turn.executionAdmission){await turn.executionAdmission.submitted();turn.executionAdmission.dispatched=true;}
      const handover=turn.executionAdmission?.handover;
      const result=await this.sandboxJobs.run({userId,session:{...session,id:session.publicConversationId??session.id},workspaceContext:turn.workspaceContext,model:chosen,variant:chosenVariant,text:`${handover?.context??(stale?handoverText(session.history):"")}${text}`,
        turnIdentity:turn.executionAdmission?.identity,identityRevision:profile.identityRevision,
        onCleanup:async({cleanupVerified})=>{turn.nativeCleanupVerified=cleanupVerified===true;},
        onAccepted:async native=>{
          if(typeof native.nativeSessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(native.nativeSessionId))throw issue('invalid_native_acceptance','Invalid native acceptance',503);
          if(turn.executionAdmission)await turn.executionAdmission.acceptedNative({runtime:session.runtime,...native});
          acceptedNativeSessionId=native.nativeSessionId;
          if(this.conversationRevert&&revertOwner&&revertInput)await this.conversationRevert.accept?.(revertOwner,revertInput);
          if(session.nativeSessionId&&session.identityRevision&&(session.nativeSessionId!==native.nativeSessionId||session.identityRevision!==profile.identityRevision)) {
            const history=session.bindingHistory??=[];
            if(!history.some(previous=>previous.nativeSessionId===session.nativeSessionId&&previous.identityRevision===session.identityRevision)) {
              if(history.length>=128)throw issue('conversation_history_full','Native binding history is full',507);
              history.push({nativeSessionId:session.nativeSessionId,identityRevision:session.identityRevision});
            }
          }
          session.nativeSessionId=native.nativeSessionId;session.identityRevision=profile.identityRevision;
          if(turn.executionAdmission)session.revertVersion=turn.executionAdmission.revertVersion??0;
          await this.persistUser(state);
          if(turn.executionAdmission){
            session._publicMessageId=turn.executionAdmission.publicMessageId;
          }
          this.emitMessageUpdated(userId,session,userMessage);this.emitMessageUpdated(userId,session,assistant);
        },
        images:(attachmentInput?.images??[]).map(image=>image.url),nativeSessionId:handover?handover.resumeNativeSessionId:stale?undefined:session.nativeSessionId,signal:controller.signal,
        emit:async event=>{
          if(event.type==="text")this.appendAssistantText(userId,session,assistant,event.text);
          else if(event.type==="question") {
            const pending={id:event.id,sessionID:session.publicConversationId??session.id,questions:event.questions};
            this.nativeQuestions.set(event.id,{userId,...pending});this.emit(userId,{type:"question.asked",properties:pending});
          } else if(event.type==="approval") {
            const pending={id:event.id,sessionID:session.publicConversationId??session.id,permission:event.kind==="edit"?"edit":"bash",patterns:event.command?[event.command]:[],metadata:{}};
            this.nativeApprovals.set(event.id,{userId,...pending});
            this.emit(userId,{type:"permission.asked",properties:pending});
          } else if(event.type==="tool-output") {
            const part={id:`prt_${randomUUID()}`,type:"text",text:event.text,synthetic:true};
            assistant.parts.push(part);this.emitText(userId,session,assistant,part);
          } else if(event.type==='tool') {
            let part=assistant.parts.find(part=>part.type==='tool'&&part.callID===event.callId);
            if(!part){part={id:`prt_${randomUUID()}`,type:'tool',callID:event.callId,tool:event.tool,
              messageID:assistant.info.id,sessionID:session.id};assistant.parts.push(part);}
            const start=part.state?.time?.start??now();
            part.state={title:event.tool,metadata:{},...structuredClone(event.state),time:{start,...(event.state.status!=='running'?{end:now()}:{})}};
            this.emitTool(userId,session,assistant,part);
          }
        }});
      if(turn.executionAdmission&&(!acceptedNativeSessionId||result.nativeSessionId!==acceptedNativeSessionId)){
        turn.nativeCleanupVerified=false;throw issue('native_identity_conflict','Native completion conflicts with acceptance',503);
      }
      session.nativeSessionId=result.nativeSessionId;session.identityRevision=profile.identityRevision;
      session.model=managedModelKey(session.runtime,chosen);session.variant=chosenVariant;
    } catch {
      if(!turn.cancelled){assistant.info.error={name:"CliRuntimeError",data:{message:"Isolated AI assistant turn failed. Retry after checking the workspace status."}};
        this.emit(userId,{type:"session.error",properties:{sessionID:session.id,error:assistant.info.error}});}
    } finally {
      for(const [id,pending]of this.nativeApprovals)if(pending.userId===userId && pending.sessionID===(session.publicConversationId??session.id))this.nativeApprovals.delete(id);
      for(const [id,pending]of this.nativeQuestions)if(pending.userId===userId && pending.sessionID===(session.publicConversationId??session.id))this.nativeQuestions.delete(id);
      for(const part of assistant.parts)if(part.type==='tool'&&part.state.status==='running'){
        part.state={status:'error',input:part.state.input,error:'Execution interrupted or unavailable.',time:{start:part.state.time.start,end:now()}};
        this.emitTool(userId,session,assistant,part);
      }
      assistant.info.time.completed=now();
      assistant.info.finish=turn.cancelled?'cancelled':'stop';
      if(!turn.executionAdmission||acceptedNativeSessionId)this.emitMessageUpdated(userId,session,assistant);
      if(assistant.parts.length || assistant.info.error)session.history.push(assistant);
      session.updatedAt=now();
      try{
        if(captured){
          await this.persistUser(state);
          if(acceptedNativeSessionId&&turn.nativeCleanupVerified===true)await this.conversationRevert.complete(revertOwner,
            {...revertInput,messageID:turn.executionAdmission.publicMessageId(userMessageId),cleanupVerified:true});
          else if(!acceptedNativeSessionId)await this.conversationRevert.discard(revertOwner,revertInput);
        }
      }finally{
        session.status="idle";this.processes.delete(session.id);this.turnReservations.delete(session.id);await this.persistUser(state);
        this.emit(userId,{type:"session.idle",properties:{sessionID:session.id}});
      }
    }
  }

  async startReservedPrompt(turn) {
    const { userId, state, session, text, displayText, profile, chosen, chosenVariant, attachmentInput } = turn;
    if(this.sandboxJobs)return this.startSandboxPrompt(turn);
    await this.ensureSkills(state);
    const pinned = await this.profileResolver.copyForTurn(profile, { paths: state.paths });
    if (turn.cancelled) throw issue("turn_cancelled", "turn was cancelled", 409);
    const stale = Boolean(session.nativeSessionId && session.identityRevision !== profile.identityRevision);
    const prompt = `${stale ? handoverText(session.history) : ""}${text}`;
    const childSpec = this.commandFor(state, { ...session, model: chosen, variant: chosenVariant }, prompt, stale ? null : session.nativeSessionId, attachmentInput);
    const redact = (value) => {
      let result = String(value ?? "");
      let authValues = [];
      try {
        const walk = (item) => typeof item === "string" ? [item] : item && typeof item === "object" ? Object.values(item).flatMap(walk) : [];
        authValues = walk(JSON.parse(profile.files?.auth ?? "null")).filter((item) => item.length >= 8);
      } catch { /* The raw auth file is never exposed. */ }
      for (const secret of [profile.files?.token, ...(profile.files?.secrets ?? []), profile.files?.baseUrl, profile.files?.main, profile.files?.catalogPath, profile.files?.home, pinned.codexHome, pinned.configDir, state.paths.root, ...authValues]) {
        if (secret && secret.length > 2) result = result.replaceAll(secret, "[redacted]");
      }
      return result;
    };
    // Diagnostic strings may contain a provider's unbounded error payload;
    // ordinary answers and tool results must remain complete and keep cited URLs.
    const diagnostic = (value) => redact(value).slice(0, 2000);
    session._redact = redact;
    const timestamp = now(),userMessageId=attachmentInput?.turn?.messageID ?? `msg_cli_${randomUUID()}`;
    const userMessage = {
      info: {
        id: userMessageId,
        role: "user",
        sessionID: session.id,
        time: { created: timestamp, completed: timestamp },
      },
      ...(attachmentInput ? { attachments: attachmentInput.metadata } : {}),
      parts: [textPart(displayText ?? text, userMessageId, session.id)],
    };
    session.history.push(userMessage);
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
        env: this.childEnvironment(state, session.runtime, pinned),
        stdio: [attachmentInput?.images?.length && session.runtime === "claude" ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const completed = now();
      const message = diagnostic(error instanceof Error ? error.message : String(error));
      delete session._redact;
      delete session._pendingNativeSessionId;
      delete session._error;
      delete session._turnFailed;
      assistantMessage.info.time.completed = completed;
      assistantMessage.info.error = { name: "CliRuntimeError", data: { message } };
      session.history.push(assistantMessage);
      session.status = "idle";
      this.turnReservations.delete(session.id);
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
    if (attachmentInput?.images?.length && session.runtime === "claude") {
      child.stdin.on("error", () => {});
      child.stdin.end(claudeUserInput(prompt, attachmentInput.images));
    }
    this.processes.set(session.id, child);
    const output = { stderr: "", stdout: "" };
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) this.terminate(child);
    }, this.turnTimeoutMs);
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (this.processes.get(session.id) === child) this.processes.delete(session.id);
      const completed = now();
      assistantMessage.info.time.completed = completed;
      // Codex may emit an item-level error while recovering from a provider
      // warning, then finish the turn successfully with an answer and exit 0.
      // Only a terminal turn failure should override that successful result.
      const recoveredCodex = session.runtime === "codex" && code === 0 && !session._turnFailed
        && assistantMessage.parts.some((part) => part.type === "text" && part.text);
      const errorText = turn.cancelled ? "" : diagnostic((recoveredCodex ? null : session._error) ?? (code === 0 ? "" : output.stderr.trim() || `agent exited (code=${code ?? "null"}, signal=${signal ?? "none"})`));
      delete session._error;
      delete session._turnFailed;
      if (errorText) {
        assistantMessage.info.error = { name: "CliRuntimeError", data: { message: errorText } };
        this.emit(userId, {
          type: "session.error",
          properties: { sessionID: session.id, error: assistantMessage.info.error },
        });
      }
      if (assistantMessage.parts.length > 0 || assistantMessage.info.error) {
        session.history.push(assistantMessage);
      }
      if (!errorText && code === 0) {
        session.nativeSessionId = session._pendingNativeSessionId ?? session.nativeSessionId;
        session.identityRevision = profile.identityRevision;
        session.model = managedModelKey(session.runtime, chosen);
        session.variant = chosenVariant;
      }
      delete session._pendingNativeSessionId;
      delete session._redact;
      session.status = "idle";
      this.turnReservations.delete(session.id);
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
      session._error = redact(error.message);
      void finish(1, null).catch(() => this.logger({ type: "cli.turn.persist_error" }));
    });
    child.once("close", (code, signal) => {
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      void finish(code, signal).catch(() => this.logger({ type: "cli.turn.persist_error" }));
    });
    this.logger({ type: "cli.turn.started", userId, sessionId: session.id, runtime: session.runtime });
  }

  parseClaudeEvent(userId, session, assistantMessage, event) {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      session._pendingNativeSessionId = event.session_id;
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
            input: block.input ? { redacted: true } : undefined,
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
      session._pendingNativeSessionId = event.thread_id;
      return;
    }
    if (event.type === "turn.failed") {
      session._turnFailed = true;
      session._error = event.error?.message ?? "Codex turn failed";
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
        title: item.command ? session._redact?.(item.command) ?? "[redacted]" : "command",
        status,
        input: item.command ? { command: session._redact?.(item.command) ?? "[redacted]" } : undefined,
        output: item.aggregated_output ? session._redact?.(item.aggregated_output) ?? "[redacted]" : undefined,
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
    part.text = `${part.text ?? ""}${session._redact ? session._redact(text) : text}`;
    this.emitText(userId, session, assistantMessage, part);
  }

  async abortSession(userId, sessionId, includeOtherRuntimes = false) {
    const state = await this.ensureUser(userId);
    const session = includeOtherRuntimes ? state.sessions.get(sessionId)??[...state.sessions.values()].find(value=>value.publicConversationId===sessionId&&value.runtime===this.runtimeForUser(userId))
      :(await this.getOwnedSession(userId,sessionId)).session;
    if (!session || !includeOtherRuntimes && session.runtime !== this.runtimeForUser(userId)) throw issue("unknown_session", "session not found", 404);
    const turn = this.turnReservations.get(session.id);
    if (turn) turn.cancelled = true;
    const child = this.processes.get(session.id);
    if (child) this.terminate(child);
  }

  terminate(child) {
    if(child instanceof AbortController){child.abort();return;}
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
      return;
    }
    const kill = (signal) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    const escalation = setTimeout(() => kill("SIGKILL"), 2000);
    escalation.unref();
  }

  async handle(request, response, { userId, workspaceDir, promptBody, attachmentInput, workspaceContext, executionAdmission, renameConversation }) {
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
        await this.workspaceAccess?.(userId,resolve(destination));
        session.directory = resolve(destination);
        session.updatedAt = now();
        await this.persistUser(state);
        sendJson(response, 200, {});
      } catch (error) {
        sendJson(response, error.status ?? 400, { error: error.message });
      }
      return true;
    }
    if(path==='/session/status'&&request.method==='GET'){
      const state=await this.ensureUser(userId),runtime=this.runtimeForUser(userId),statuses={};
      const directory=parsed.searchParams.get('directory');
      if(directory!==null&&!isWithin(workspaceDir,directory))throw issue('invalid_directory','Directory is outside the workspace',403);
      for(const session of state.sessions.values()){
        if(session.runtime!==runtime||directory!==null&&resolve(directory)!==session.directory||
          session.status!=='running'&&!this.turnReservations.has(session.id))continue;
        await this.workspaceAccess?.(userId,session.directory);
        statuses[session.publicConversationId??session.id]={type:'busy'};
      }
      sendJson(response,200,statuses);return true;
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
          if (typeof body.title === "string" && body.title.trim()) {
            const title=body.title.trim().slice(0,240);
            // The public title belongs to canonical metadata after a handover;
            // updating only this native alias makes it disappear on reload.
            await renameConversation?.(session,title);
            session.title=title;
          }
          if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) session.metadata = body.metadata;
          session.updatedAt = now();
          await this.persistUser(state);
          sendJson(response, 200, publicSession(session));
        } else if (!route && request.method === "DELETE") {
          const { state, session } = await this.getOwnedSession(userId, sessionId);
          const child = this.processes.get(session.id);
          if (child) this.terminate(child);
          state.sessions.delete(session.id);
          await this.persistUser(state);
          sendJson(response, 200, true);
        } else if (route === "prompt_async" && request.method === "POST") {
          if(this.sandboxJobs && workspaceContext && !executionAdmission)
            throw issue("assistant_admission_required","Canonical execution admission is required",503);
          const body = promptBody ?? await jsonBody(request);
          const text = Array.isArray(body.parts)
            ? body.parts.filter((part) => part?.type === "text" && !part.synthetic).map((part) => part.text ?? "").join("\n")
            : "";
          let model;
          if (body.model !== undefined) {
            if (body.model?.providerID !== this.runtimeForUser(userId)) throw issue("invalid_model", "model belongs to another AI assistant");
            model = normalizeModelId(body.model.modelID);
          }
          const turn = await this.reservePrompt({ userId, sessionId, text: body.system ? `${body.system}\n${text || "Attached files"}` : text, displayText: attachmentInput?.displayText ?? (promptBody ? text : undefined), model, variant: body.variant, attachmentInput, workspaceContext, executionAdmission });
          void this.runReservedPrompt(turn).catch(() => {
            this.logger({ type: "cli.turn.error", userId, sessionId });
          });
          sendJson(response, 202, {});
        } else if (route === "abort" && request.method === "POST") {
          await this.abortSession(userId, sessionId);
          sendJson(response, 200, true);
        } else if (route === "command" && request.method === "POST") {
          if(this.sandboxJobs && workspaceContext)throw issue("assistant_admission_required","Canonical command admission is required",503);
          const body = await jsonBody(request);
          const command = typeof body.command === "string" ? body.command : "";
          const args = typeof body.arguments === "string" ? body.arguments : "";
          const turn = await this.reservePrompt({ userId, sessionId, text: `/${command}${args ? ` ${args}` : ""}`, workspaceContext });
          void this.runReservedPrompt(turn).catch(() => {
            this.logger({ type: "cli.command.error", userId, sessionId });
          });
          sendJson(response, 202, {});
        } else if (route === "shell" && request.method === "POST") {
          sendJson(response, 501, { error: "direct shell commands are disabled in the administrator-managed runtime" });
        } else if (route === "fork" && request.method === "POST") {
          const { session } = await this.getOwnedSession(userId, sessionId);
          const copy = await this.createSession({ userId, workspaceDir, directory: session.directory, title: `${session.title} (fork)` });
          const target = await this.getOwnedSession(userId, copy.id);
          target.session.parentId = session.id;
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
      try {
        const state = await this.ensureUser(userId);
        const bundled = await this.ensureSkills(state);
        sendJson(response, 200, await discoverSkills({
          home: state.paths.home,
          runtime: this.runtimeForUser(userId),
          workspaceDir,
          directory: parsed.searchParams.get("directory") ?? workspaceDir,
          bundled,
        }));
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: "Could not load skills for this workspace" });
      }
      return true;
    }
    if (path === "/global/config" && request.method === "GET") {
      const runtime = this.runtimeForUser(userId);
      await this.refreshProfiles();
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
      await this.refreshProfiles();
      const runtime = this.runtimeForUser(userId);
      const { models } = this.managedRuntimes[runtime];
      sendJson(response, 200, {
        providers: [{
          id: runtime,
          name: runtimeDescriptor(runtime).label,
          models: Object.fromEntries(models.map((model) => [
            model,
            { name: model, variants: this.profiles.get(runtime)?.models.find((item) => item.id === model)?.variants ?? {}, limit: { context: 0 } },
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
    if(this.sandboxJobs && path==="/permission" && request.method==="GET") {
      sendJson(response,200,await this.visibleInteractions(userId,this.nativeApprovals));return true;
    }
    const nativeReply=this.sandboxJobs && /^\/permission\/([a-f0-9]{64})\/reply$/.exec(path);
    if(nativeReply && request.method==="POST") {
      try {
        const value=await jsonBody(request);const pending=this.nativeApprovals.get(nativeReply[1]);
        if(!pending || pending.userId!==userId || !["once","reject"].includes(value.reply))throw issue("permission_unavailable","permission unavailable",403);
        await this.getOwnedSession(userId,pending.sessionID);
        await this.sandboxJobs.approve({userId,sessionId:pending.sessionID,id:pending.id,decision:value.reply==="once"?"accept":"decline"});
        this.nativeApprovals.delete(pending.id);this.emit(userId,{type:"permission.replied",properties:{sessionID:pending.sessionID,requestID:pending.id,reply:value.reply}});
        sendJson(response,200,true);
      }catch(error){sendJson(response,error.statusCode??error.status??403,{error:"permission unavailable"});}
      return true;
    }
    if(this.sandboxJobs && path==="/question" && request.method==="GET") {
      sendJson(response,200,await this.visibleInteractions(userId,this.nativeQuestions));return true;
    }
    const questionReply=this.sandboxJobs && /^\/question\/([a-f0-9]{64})\/(reply|reject)$/.exec(path);
    if(questionReply && request.method==="POST") {
      try {
        const value=await jsonBody(request);const pending=this.nativeQuestions.get(questionReply[1]);const reject=questionReply[2]==="reject";
        if(!pending || pending.userId!==userId || Object.keys(value).some(key=>key!=="answers"))throw issue("question_unavailable","question unavailable",403);
        await this.getOwnedSession(userId,pending.sessionID);
        await this.sandboxJobs.answer({userId,sessionId:pending.sessionID,id:pending.id,...(reject?{reject:true}:{answers:value.answers})});
        this.nativeQuestions.delete(pending.id);this.emit(userId,{type:reject?"question.rejected":"question.replied",properties:{sessionID:pending.sessionID,requestID:pending.id}});
        sendJson(response,200,true);
      }catch(error){sendJson(response,error.statusCode??error.status??403,{error:"question unavailable"});}
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

  async visibleInteractions(userId,requests) {
    const visible=[];
    for(const {userId:owner,...value}of requests.values()){
      if(owner!==userId)continue;
      try{await this.getOwnedSession(userId,value.sessionID);visible.push(value);}
      catch(error){if(!["project_trashed","unknown_session"].includes(error.code))throw error;}
    }
    return visible;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.processes.values()) {
      try {
        this.terminate(child);
      } catch {
        // Already exited.
      }
    }
    await Promise.allSettled([...this.activeTurns]);
    this.processes.clear();
    for (const set of this.subscribers.values()) {
      for (const subscription of set) subscription.response.end();
    }
    this.subscribers.clear();
    await Promise.all([...this.persistQueues.values()].map((queue) => queue.catch(() => {})));
    await this.configPersistQueue.catch(() => {});
    this.#policyStopped = true;
  }
}
