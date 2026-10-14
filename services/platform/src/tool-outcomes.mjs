import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { isToolCallId, readToolError } from '../../../packages/sdk/src/tool-outcome.mjs';
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid outcome owner');
  return value;
};
const toolCallId = value => {
  if (!isToolCallId(value)) throw new TypeError('Invalid tool call identifier');
  return value;
};
export class ToolOutcomes {
  constructor({ rootDir, now = Date.now }) { this.rootDir = resolve(rootDir); this.now = now; this.queues = new Map(); }
  path(owner) { return join(this.rootDir, identifier(owner.userId), `${identifier(owner.sessionId)}.json`); }
  async locked(owner, fn) {
    const key = this.path(owner), prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  async load(owner) {
    const path = this.path(owner);
    try {
      if ((await fs.stat(path)).size > 256 * 1024) throw new Error('Invalid saved tool outcomes');
      const value = JSON.parse(await fs.readFile(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.records) || value.records.length > 256) throw new Error('Invalid saved tool outcomes');
      for (const record of value.records) {
        toolCallId(record.callId);
        if (!Number.isSafeInteger(record.execution) || record.execution < 0 || !readToolError(JSON.stringify({ error: record.outcome }))) throw new Error('Invalid saved tool outcome');
      }
      if (value.stops && (!Number.isSafeInteger(value.stops.execution) || value.stops.execution < 0 || !Array.isArray(value.stops.callIds) || value.stops.callIds.length > 256)) throw new Error('Invalid saved stop');
      value.stops?.callIds.forEach(toolCallId);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: [], stops: null };
      throw error;
    }
  }
  async save(owner, snapshot) {
    snapshot.records = snapshot.records.slice(-256);
    let bytes = JSON.stringify(snapshot) + '\n';
    while (Buffer.byteLength(bytes) > 256 * 1024 && snapshot.records.length > 1) {
      snapshot.records.shift(); bytes = JSON.stringify(snapshot) + '\n';
    }
    if (Buffer.byteLength(bytes) > 256 * 1024) throw new Error('Tool outcome snapshot exceeds limit');
    const path = this.path(owner), temporary = `${path}.${randomUUID()}.tmp`;
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, path); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  record(owner, callId, outcome) {
    return this.locked(owner, async () => {
      toolCallId(callId);
      if (!Number.isSafeInteger(owner.execution) || owner.execution < 0) throw new TypeError('Invalid outcome execution');
      const safe = readToolError(JSON.stringify({ error: outcome }));
      if (!safe || safe.correlationId !== callId) throw new TypeError('Invalid tool outcome');
      const snapshot = await this.load(owner);
      snapshot.records = snapshot.records.filter(record => record.callId !== callId || record.execution !== owner.execution);
      snapshot.records.push({ callId, execution: owner.execution, at: this.now(), outcome: safe });
      await this.save(owner, snapshot);
    });
  }
  recordStop(owner, callIds, confirmed = true) {
    return this.locked(owner, async () => {
      if (!Number.isSafeInteger(owner.execution) || owner.execution < 0 || !Array.isArray(callIds) || callIds.length > 256) throw new TypeError('Invalid stop record');
      const snapshot = await this.load(owner);
      const stopId = randomUUID();
      snapshot.stops = { execution: owner.execution, stopId, confirmed, at: this.now(), callIds: [...new Set(callIds.map(toolCallId))] };
      await this.save(owner, snapshot);
      return stopId;
    });
  }
  confirmStop(owner, stopId) {
    return this.locked(owner, async () => {
      const snapshot = await this.load(owner);
      if (snapshot.stops?.stopId !== stopId || snapshot.stops.execution !== owner.execution) return;
      snapshot.stops.confirmed = true; await this.save(owner, snapshot);
    });
  }
  list(owner) { return this.locked(owner, () => this.load(owner)); }
}
