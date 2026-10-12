import { collaborationPermissions } from "./collaboration.mjs";

// Automatic approval belongs to the authenticated Web control plane. OpenCode's
// task children inherit deny rules but omit root allow rules; resolve their
// execution owner before replying, and keep tenant boundaries and child denies.
export class AutomaticToolPermissions {
  pending = new Map();
  constructor({ policy, authority, execution, readSession, patchSession, reply }) {
    Object.assign(this, { policy, authority, execution, readSession, patchSession, reply });
  }
  answer(context, request) {
    const key = JSON.stringify([context.userId, context.instanceId, context.generation, request.id]);
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.#answer(context, request).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
  async #answer(context, request) {
    await this.authority.ensure(context, request.sessionID);
    const pending = this.policy.registerRequest(context, request);
    const { owner, state, blocked } = await this.execution(context, pending.sessionID);
    if (blocked || state.phase !== "running" || state.execution < 1 || state.pending) return false;
    const rules = collaborationPermissions(state.executionMode ?? state.mode);
    const action = rules.filter(rule => rule.pattern === "*" && ["*", pending.permission].includes(rule.permission)).at(-1)?.action;
    if (action !== "allow") return false;
    const session = await this.readSession(context, pending.sessionID);
    const owned = this.policy.session(context, pending.sessionID);
    if (session.id !== pending.sessionID || this.policy.directory(context, session.directory) !== owned.directory || session.parentID !== owned.parentID)
      throw new Error("Automatic permission session changed");
    const denies = (session.permission ?? []).filter(rule => rule.action === "deny" && rule.permission !== "external_directory");
    if (denies.some(rule => ["*", pending.permission].includes(rule.permission))) return false;
    await this.authority.current(context);
    if (owner.sessionId !== pending.sessionID && !session.permission?.some(rule => rule.permission === "*" && rule.pattern === "*" && rule.action === "allow")) {
      await this.patchSession(context, pending.sessionID, [...rules, ...denies]);
    }
    // A concurrent Stop or checkpoint must prevent an answer after the patch.
    const latest = await this.execution(context, pending.sessionID);
    if (latest.blocked || latest.state.phase !== "running" || latest.state.execution !== state.execution || latest.state.pending) return false;
    await this.authority.current(context);
    const response = await this.reply(context, pending.id, { reply: "once" });
    if (response.status === 404) return true; // Another owner client already answered.
    if (!response.ok) throw new Error("Automatic tool permission unavailable");
    return true;
  }
}
