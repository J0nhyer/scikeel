import { randomBytes } from "node:crypto";

const fields = ["userId", "instanceId", "generation", "sessionId", "projectId", "operation", "inputHash"];
function denied() { return Object.assign(new Error("environment approval denied"), { statusCode: 403 }); }
function validate(value) {
  if (!value || !["userId", "instanceId", "sessionId", "projectId"].every((key) =>
    typeof value[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value[key])) ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 || !["install", "rebuild"].includes(value.operation) ||
    !/^[a-f0-9]{64}$/.test(value.inputHash ?? "")) throw denied();
}
export class EnvironmentApprovals {
  #records = new Map();
  constructor({ now = Date.now, maxPending = 1000 } = {}) {
    if (typeof now !== "function" || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 10000)
      throw new Error("invalid approval configuration");
    this.now = now; this.maxPending = maxPending;
  }
  request(input) {
    validate(input);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now() || input.expiresAt > this.now() + 900000) throw denied();
    for (const [id, value] of this.#records) if (value.expiresAt <= this.now() || value.used) this.#records.delete(id);
    if (this.#records.size >= this.maxPending) throw Object.assign(new Error("approval capacity reached"), { statusCode: 429 });
    const id = randomBytes(32).toString("hex");
    const record = { id, ...Object.fromEntries(fields.map((key) => [key, input[key]])), expiresAt: input.expiresAt, approved: false, used: false };
    this.#records.set(id, record); return Object.freeze({ ...record });
  }
  approve({ id, actor, manual }) {
    const record = this.#records.get(id);
    if (!record || manual !== true || actor?.userId !== record.userId || record.expiresAt <= this.now() || record.used) throw denied();
    record.approved = true; return Object.freeze({ ...record });
  }
  consume(input) {
    validate(input);
    const record = this.#records.get(input.id);
    if (!record || !record.approved || record.used || record.expiresAt <= this.now() ||
        fields.some((key) => record[key] !== input[key])) throw denied();
    // Synchronous check and mutation: no await lets concurrent installs replay this authority.
    record.used = true; return Object.freeze({ ...record });
  }
  revokeContext({ userId, instanceId, generation }) {
    for (const [id, record] of this.#records) if (record.userId === userId && record.instanceId === instanceId && record.generation === generation)
      this.#records.delete(id);
  }
}
