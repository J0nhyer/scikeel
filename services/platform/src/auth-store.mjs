import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

const STORE_VERSION = 1;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._%+@-]{2,127}$/;
const ROLES = new Set(["admin", "user"]);
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 };

function now() {
  return Date.now();
}

function issue(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw issue("invalid_password", "password must contain at least 8 characters");
  }
  if (password.length > 1_024) {
    throw issue("invalid_password", "password is too long");
  }
}

export function normalizeUsername(username) {
  if (typeof username !== "string") {
    throw issue("invalid_username", "username is required");
  }
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw issue(
      "invalid_username",
      "username must contain 3-128 lowercase letters, numbers, '.', '_', '%', '+' '@' or '-'",
    );
  }
  return normalized;
}

function assertRole(role) {
  if (!ROLES.has(role)) throw issue("invalid_role", "role must be admin or user");
}

function passwordHash(password) {
  assertPassword(password);
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, digestText] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(R) || !Number.isSafeInteger(P)) {
    return false;
  }
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    const actual = scryptSync(password, salt, expected.length, { N, r: R, p: P });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safe } = user;
  return { ...safe };
}

async function ensureDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(path, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes.
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(temporary, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  await fs.rename(temporary, path);
}

function emptyStore() {
  return { version: STORE_VERSION, users: [], sessions: [] };
}

function parseStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw issue("invalid_store", "auth store must be a JSON object");
  }
  if (value.version !== STORE_VERSION) {
    throw issue("invalid_store", `unsupported auth store version: ${value.version}`);
  }
  if (!Array.isArray(value.users) || !Array.isArray(value.sessions)) {
    throw issue("invalid_store", "auth store is missing users or sessions");
  }
  return {
    version: STORE_VERSION,
    users: value.users.filter((user) => user && typeof user.id === "string"),
    sessions: value.sessions.filter(
      (session) =>
        session &&
        typeof session.tokenHash === "string" &&
        typeof session.userId === "string" &&
        Number.isFinite(session.expiresAt),
    ),
  };
}

/**
 * Small file-backed identity store for the internal MVP.
 *
 * It keeps only password/session hashes on disk and serializes mutations so
 * two concurrent admin requests cannot overwrite one another. The store is
 * intentionally replaceable: a later deployment can put the same methods on
 * top of SQLite or an external identity provider without changing routing.
 */
export class AuthStore {
  constructor({
    filePath,
    bootstrapAdmin = null,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    clock = now,
  } = {}) {
    if (!filePath) throw new Error("filePath is required");
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new Error("sessionTtlMs must be positive");
    }
    this.filePath = resolve(filePath);
    this.bootstrapAdmin = bootstrapAdmin;
    this.sessionTtlMs = sessionTtlMs;
    this.clock = clock;
    this.data = null;
    this.initPromise = null;
    this.operationQueue = Promise.resolve();
    this.persistQueue = Promise.resolve();
  }

  async init() {
    if (this.data) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDirectory(dirname(this.filePath));
        let loaded;
        try {
          loaded = JSON.parse(await fs.readFile(this.filePath, "utf8"));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          loaded = emptyStore();
        }
        this.data = parseStore(loaded);
        const changed = this.#pruneExpiredSessions();
        if (this.data.users.length === 0 && this.bootstrapAdmin) {
          const { username, password } = this.bootstrapAdmin;
          this.data.users.push(this.#newUser(username, password, "admin"));
          await this.#persist();
        } else if (changed) {
          await this.#persist();
        }
      })();
    }
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      this.data = null;
      throw error;
    }
  }

  #newUser(username, password, role) {
    const normalized = normalizeUsername(username);
    assertPassword(password);
    assertRole(role);
    const timestamp = new Date(this.clock()).toISOString();
    return {
      id: `usr_${randomBytes(12).toString("hex")}`,
      username: normalized,
      passwordHash: passwordHash(password),
      role,
      disabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  #pruneExpiredSessions() {
    const before = this.data.sessions.length;
    const timestamp = this.clock();
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > timestamp);
    return before !== this.data.sessions.length;
  }

  async #persist() {
    const snapshot = {
      version: STORE_VERSION,
      users: this.data.users.map((user) => ({ ...user })),
      sessions: this.data.sessions.map((session) => ({ ...session })),
    };
    this.persistQueue = this.persistQueue.then(async () => {
      await ensureDirectory(dirname(this.filePath));
      await writeJsonAtomic(this.filePath, snapshot);
    });
    return this.persistQueue;
  }

  async #exclusive(fn) {
    await this.init();
    const run = this.operationQueue.then(fn, fn);
    this.operationQueue = run.catch(() => {});
    return run;
  }

  async createUser({ username, password, role = "user" } = {}) {
    return this.#exclusive(async () => {
      const normalized = normalizeUsername(username);
      assertPassword(password);
      assertRole(role);
      if (this.data.users.some((user) => user.username === normalized)) {
        throw issue("duplicate_username", "username is already in use");
      }
      const user = this.#newUser(normalized, password, role);
      this.data.users.push(user);
      await this.#persist();
      return publicUser(user);
    });
  }

  async authenticate(username, password) {
    await this.init();
    const normalized = typeof username === "string" ? username.trim().toLowerCase() : "";
    const user = this.data.users.find((candidate) => candidate.username === normalized);
    if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) return null;
    return publicUser(user);
  }

  async createSession(userId) {
    return this.#exclusive(async () => {
      const user = this.data.users.find((candidate) => candidate.id === userId);
      if (!user || user.disabled) return null;
      const token = randomBytes(32).toString("base64url");
      const createdAt = this.clock();
      const expiresAt = createdAt + this.sessionTtlMs;
      this.data.sessions.push({
        tokenHash: hashSessionToken(token),
        userId,
        createdAt,
        expiresAt,
      });
      await this.#persist();
      return { token, expiresAt };
    });
  }

  async getUserBySession(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    return this.#exclusive(async () => {
      const changed = this.#pruneExpiredSessions();
      const session = this.data.sessions.find((candidate) => candidate.tokenHash === hashSessionToken(token));
      const user = session ? this.data.users.find((candidate) => candidate.id === session.userId) : null;
      if (changed) await this.#persist();
      if (!session || !user || user.disabled) return null;
      return publicUser(user);
    });
  }

  async revokeSession(token) {
    if (typeof token !== "string" || token.length < 20) return false;
    return this.#exclusive(async () => {
      const tokenHash = hashSessionToken(token);
      const before = this.data.sessions.length;
      this.data.sessions = this.data.sessions.filter((session) => session.tokenHash !== tokenHash);
      if (before !== this.data.sessions.length) await this.#persist();
      return before !== this.data.sessions.length;
    });
  }

  async getUser(userId) {
    await this.init();
    return publicUser(this.data.users.find((user) => user.id === userId));
  }

  async listUsers() {
    await this.init();
    return this.data.users.map(publicUser);
  }

  async setPassword(userId, password) {
    return this.#exclusive(async () => {
      assertPassword(password);
      const user = this.data.users.find((candidate) => candidate.id === userId);
      if (!user) throw issue("unknown_user", "user not found");
      user.passwordHash = passwordHash(password);
      user.updatedAt = new Date(this.clock()).toISOString();
      // Password rotation invalidates every existing browser login for this
      // account, including a session copied from another device.
      this.data.sessions = this.data.sessions.filter((session) => session.userId !== user.id);
      await this.#persist();
      return publicUser(user);
    });
  }

  async disableUser(userId, disabled = true) {
    return this.#exclusive(async () => {
      const user = this.data.users.find((candidate) => candidate.id === userId);
      if (!user) throw issue("unknown_user", "user not found");
      if (disabled && user.role === "admin" && !user.disabled) {
        const activeAdmins = this.data.users.filter((candidate) => candidate.role === "admin" && !candidate.disabled);
        if (activeAdmins.length <= 1) throw issue("last_admin", "cannot disable the last active administrator");
      }
      user.disabled = Boolean(disabled);
      user.updatedAt = new Date(this.clock()).toISOString();
      if (user.disabled) {
        this.data.sessions = this.data.sessions.filter((session) => session.userId !== user.id);
      }
      await this.#persist();
      return publicUser(user);
    });
  }

  async close() {
    await this.operationQueue;
    await this.persistQueue;
  }
}

export const authStoreDefaults = {
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
};
