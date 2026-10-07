import { posix } from "node:path";

function denied(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
export function relativeInput(value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      value.includes("\\") || value.startsWith("/") ||
      value.split("/").some((part) => ["..", ".", ""].includes(part)))
    throw denied(400, "invalid relative path");
  return value;
}
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw denied(400, "invalid identifier");
  return value;
}
function absoluteDirectory(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") ||
      value.includes("\\") || posix.normalize(value) !== value ||
      value.slice(1).split("/").some((part) => ["..", ".", ""].includes(part)))
    throw denied(403, "directory is not owned");
  return value;
}

// Only platform-authenticated account records may populate this registry.
// Lexical directory checks are input checks; the file core enforces OS access.
export class TenantPolicy {
  #accounts = new Map();
  #sessions = new Map();
  #requests = new Map();
  constructor({ accounts = [] } = {}) {
    for (const record of accounts) this.registerAccount(record);
  }
  registerAccount(record) {
    identifier(record?.instanceId);
    identifier(record?.userId);
    absoluteDirectory(record?.workspaceDir);
    if (!Number.isSafeInteger(record.generation) || record.generation < 1)
      throw denied(400, "invalid generation");
    const previous = this.#accounts.get(record.instanceId);
    if (previous && (previous.userId !== record.userId || previous.workspaceDir !== record.workspaceDir ||
        record.generation < previous.generation)) throw denied(403, "account authority cannot be reassigned");
    this.#accounts.set(record.instanceId, Object.freeze({ userId: record.userId,
      instanceId: record.instanceId, generation: record.generation, workspaceDir: record.workspaceDir }));
  }
  account(context) {
    const record = this.#accounts.get(context?.instanceId);
    if (!record || record.userId !== context.userId || record.generation !== context.generation)
      throw denied(404, "account not found");
    return record;
  }
  directory(context, value) {
    const { workspaceDir } = this.account(context);
    if (value === undefined) return workspaceDir;
    absoluteDirectory(value);
    if (value !== workspaceDir && !value.startsWith(`${workspaceDir}/`))
      throw denied(403, "directory is not owned");
    return value;
  }
  #key(context, id) {
    const account = this.account(context);
    return `${account.instanceId}:${account.generation}:${identifier(id)}`;
  }
  registerSession(context, record) {
    const directory = this.directory(context, record.directory);
    const key = this.#key(context, record.id);
    if (record.parentID) this.session(context, record.parentID);
    const safe = Object.freeze({ id: record.id, directory,
      ...(record.parentID ? { parentID: record.parentID } : {}) });
    this.#sessions.set(key, safe);
    return safe;
  }
  registerSessionList(context, records) {
    if (!Array.isArray(records) || records.length > 10000) throw denied(400, "invalid session list");
    const candidates = new Map();
    for (const record of records) {
      identifier(record.id);
      this.directory(context, record.directory);
      if (candidates.has(record.id)) throw denied(400, "duplicate session identifier");
      candidates.set(record.id, record);
    }
    // Check the whole batch before granting any new authority.
    for (const record of records) if (record.parentID) {
      identifier(record.parentID);
      if (record.parentID === record.id) throw denied(400, "invalid parent session");
      if (!candidates.has(record.parentID)) this.session(context, record.parentID);
    }
    for (const record of records) this.#sessions.set(this.#key(context, record.id), Object.freeze({
      id: record.id, directory: record.directory, ...(record.parentID ? { parentID: record.parentID } : {}),
    }));
  }
  session(context, id) {
    const session = this.#sessions.get(this.#key(context, id));
    if (!session) throw denied(404, "session not found");
    return session;
  }
  removeSession(context, id) {
    this.#sessions.delete(this.#key(context, id));
  }
  registerRequest(context, record) {
    this.session(context, record.sessionID);
    const safe = Object.freeze({ id: identifier(record.id), sessionID: record.sessionID });
    this.#requests.set(this.#key(context, record.id), safe);
    return safe;
  }
  request(context, id) {
    const request = this.#requests.get(this.#key(context, id));
    if (!request) throw denied(404, "request not found");
    return request;
  }
}
