const MAX_ACCOUNTS = 253;
const MAX_SAFE_GENERATION = 9_007_199_254_740_991;
const STATUSES = new Set(["registered", "starting", "ready", "stopped", "unavailable"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 &&
    /^[A-Za-z0-9]/.test(value) && /^[A-Za-z0-9_-]+$/.test(value);
}

function snapshot(account) {
  return Object.freeze({
    instanceId: account.instanceId,
    userId: account.userId,
    generation: account.generation,
    status: account.status,
    imageDigest: account.imageDigest,
    lastStoppedGeneration: account.lastStoppedGeneration,
  });
}

function normalize(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) fail("invalid_registry");
  return {
    instanceId: account.instanceId,
    userId: account.userId,
    generation: account.generation,
    status: account.status,
    imageDigest: account.imageDigest ?? null,
    lastStoppedGeneration: account.lastStoppedGeneration ?? null,
  };
}

export class Registry {
  #accounts;

  constructor({ accounts = {} } = {}) {
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) fail("invalid_registry");
    this.#accounts = Object.create(null);
    for (const [instanceId, raw] of Object.entries(accounts)) {
      const account = normalize(raw);
      if (account.instanceId !== instanceId) fail("invalid_registry");
      this.#accounts[instanceId] = account;
    }
    this.validate();
  }

  static fromJSON(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1 ||
        !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
      fail("invalid_registry");
    }
    return new Registry({ accounts: value.accounts });
  }

  toJSON() {
    return {
      schema: 1,
      accounts: Object.fromEntries(Object.entries(this.#accounts).map(([instanceId, account]) => [instanceId, snapshot(account)])),
    };
  }

  get accounts() {
    return Object.freeze(Object.values(this.#accounts).map(snapshot));
  }

  register(instanceId, userId) {
    if (!identifier(instanceId) || !identifier(userId)) fail("invalid_binding");
    const existing = this.#accounts[instanceId];
    if (existing) {
      if (existing.userId !== userId) fail("foreign_instance");
      return snapshot(existing);
    }
    if (Object.values(this.#accounts).some((account) => account.userId === userId)) fail("foreign_user");
    if (Object.keys(this.#accounts).length >= MAX_ACCOUNTS) fail("registry_full");
    const account = {
      instanceId,
      userId,
      generation: 1,
      status: "registered",
      imageDigest: null,
      lastStoppedGeneration: null,
    };
    this.#accounts[instanceId] = account;
    return snapshot(account);
  }

  account(instanceId) {
    const account = this.#accounts[instanceId];
    if (!account) fail("unknown_instance");
    return snapshot(account);
  }

  beginStart(instanceId, generation, imageDigest) {
    const account = this.#accounts[instanceId];
    if (!account) fail("unknown_instance");
    if (account.generation !== generation) fail("stale_generation");
    if (typeof imageDigest !== "string" || !DIGEST.test(imageDigest)) fail("invalid_image");
    if (account.status === "starting" || account.status === "ready") fail("already_started");
    account.status = "starting";
    account.imageDigest = imageDigest;
    return snapshot(account);
  }

  markReady(instanceId, generation) {
    const account = this.#accounts[instanceId];
    if (!account) fail("unknown_instance");
    if (account.generation !== generation || account.status !== "starting") fail("stale_generation");
    account.status = "ready";
  }

  markStopped(instanceId, generation, failed) {
    const account = this.#accounts[instanceId];
    if (!account) fail("unknown_instance");
    if (account.lastStoppedGeneration === generation) return;
    if (account.generation !== generation) fail("stale_generation");
    if (account.generation >= MAX_SAFE_GENERATION) fail("generation_exhausted");
    account.lastStoppedGeneration = generation;
    account.generation += 1;
    account.status = failed ? "unavailable" : "stopped";
  }

  validate() {
    const entries = Object.entries(this.#accounts);
    if (entries.length > MAX_ACCOUNTS) fail("registry_full");
    const users = new Set();
    for (const [instanceId, account] of entries) {
      if (instanceId !== account.instanceId || !identifier(instanceId) || !identifier(account.userId) ||
          !Number.isSafeInteger(account.generation) || account.generation < 1 || account.generation > MAX_SAFE_GENERATION ||
          !STATUSES.has(account.status) || users.has(account.userId) ||
          account.imageDigest !== null && !DIGEST.test(account.imageDigest) ||
          account.lastStoppedGeneration !== null &&
            (!Number.isSafeInteger(account.lastStoppedGeneration) || account.lastStoppedGeneration < 1 ||
             account.lastStoppedGeneration >= account.generation)) {
        fail("invalid_registry");
      }
      users.add(account.userId);
    }
  }
}
