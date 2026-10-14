import type { SessionMeta, SessionTitlePresentation } from "./types";

export const TITLE_WAIT_MS = 35_000;

export function hasDefaultSessionTitle(session: SessionMeta): boolean {
  const job = session.metadata?.scikeelSessionTitle as { source?: unknown } | undefined;
  if (session.parentId || job?.source === "manual" || job?.source === "automatic") return false;
  return /^(?:New session|Untitled|New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(session.title);
}

/** Mirror a successful manual rename locally while its durable event is in flight. */
export function withManualSessionTitle(session: SessionMeta, title: string): SessionMeta {
  return { ...session, title, titlePresentation: undefined,
    metadata: { ...session.metadata, scikeelSessionTitle: {
      ...((session.metadata?.scikeelSessionTitle as Record<string, unknown>) ?? {}), source: "manual",
    } },
  };
}

/** Only visible user parts; never reasonings, tools, synthetic instructions or URLs. */
export function titleExcerpt(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return;
  const visible = parts.filter(p => p && typeof p === "object" && !p.synthetic);
  const text = visible.filter(p => p.type === "text" && typeof p.text === "string").map(p => p.text).join(" ").replace(/\s+/g, " ").trim();
  const names = visible.filter(p => p.type === "file" && typeof p.filename === "string").map(p => p.filename).join(", ");
  const chars = Array.from(text || names.replace(/\s+/g, " ").trim());
  return chars.length ? chars.length > 60 ? chars.slice(0, 59).join("") + "…" : chars.join("") : undefined;
}

type FirstMessage = { fallback?: string; created?: number };

/** Derived from durable messages; no model calls or session writes. */
export class SessionTitleReader {
  private readonly cache = new Map<string, Promise<FirstMessage | undefined>>();
  private readonly resolved = new Map<string, FirstMessage>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;
  private generation = 0;

  constructor(private readonly read: (sessionID: string, messageID: string) => Promise<unknown>) {}

  open(): void { this.closed = false; }
  close(): void {
    this.closed = true;
    this.generation++;
    this.cache.clear();
    this.resolved.clear();
    for (const wake of this.waiting.splice(0)) wake();
  }

  private first(sessionID: string, messageID: string): Promise<FirstMessage | undefined> {
    const key = `${sessionID}/${messageID}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.waiting.length >= 126) return Promise.resolve(undefined);
    const generation = this.generation;
    const pending = (async () => {
      while (this.active >= 2 && !this.closed && generation === this.generation) await new Promise<void>(resolve => this.waiting.push(resolve));
      if (this.closed || generation !== this.generation) return;
      this.active++;
      try {
        const message = await this.read(sessionID, messageID) as { info?: { id?: string; role?: string; time?: { created?: number } }; parts?: unknown; attachments?: Array<{ name?: string }> };
        if (message?.info?.role !== "user" || message.info.id !== messageID) return;
        const parts = [...(Array.isArray(message.parts) ? message.parts : []), ...(Array.isArray(message.attachments) ? message.attachments.map(file => ({ type: "file", filename: file?.name })) : [])];
        return { fallback: titleExcerpt(parts), created: message.info.time?.created };
      } catch { return undefined; }
      finally { this.active--; this.waiting.shift()?.(); }
    })();
    this.cache.set(key, pending);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    void pending.then(value => {
      if (this.closed || generation !== this.generation) return;
      if (!value && this.cache.get(key) === pending) this.cache.delete(key);
      if (value) {
        this.resolved.set(key, value);
        if (this.resolved.size > 128) this.resolved.delete(this.resolved.keys().next().value!);
      }
    });
    return pending;
  }

  /** Immediate metadata-only state; archive/connection readiness never waits on I/O. */
  preview(session: SessionMeta): SessionMeta {
    const job = session.metadata?.scikeelSessionTitle as { firstMessageID?: string } | undefined;
    return this.format(session, this.resolved.get(`${session.id}/${job?.firstMessageID}`));
  }

  private format(session: SessionMeta, first?: FirstMessage): SessionMeta {
    if (!hasDefaultSessionTitle(session)) return { ...session, titlePresentation: undefined };
    const job = session.metadata?.scikeelSessionTitle as { version?: unknown; firstMessageID?: unknown; status?: unknown; source?: unknown } | undefined;
    if (job?.version !== 1 || job.source !== "default" || typeof job.firstMessageID !== "string" || !job.firstMessageID)
      return { ...session, titlePresentation: { status: "empty" } };
    const created = first?.created ?? session.created;
    const pendingUntil = typeof created === "number" && Number.isFinite(created) ? created + TITLE_WAIT_MS : undefined;
    const status = ["ready", "running"].includes(String(job.status)) && pendingUntil !== undefined ? "pending" : "fallback";
    const titlePresentation: SessionTitlePresentation = { status,
      ...(first?.fallback ? { fallback: first.fallback } : {}),
      ...(status === "pending" ? { pendingUntil } : {}),
    };
    return { ...session, titlePresentation };
  }

  async present(session: SessionMeta): Promise<SessionMeta> {
    if (!hasDefaultSessionTitle(session)) return this.format(session);
    const job = session.metadata?.scikeelSessionTitle as { version?: unknown; source?: unknown; firstMessageID?: unknown } | undefined;
    if (this.closed || job?.version !== 1 || job.source !== "default" || typeof job.firstMessageID !== "string" || !job.firstMessageID)
      return this.format(session);
    return this.format(session, await this.first(session.id, job.firstMessageID));
  }
}
