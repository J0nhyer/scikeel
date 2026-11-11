import type { HistoryMessage, QuestionAskedEvent } from "@ai4s/sdk";
export type InteractionStatus = "pending" | "submitting" | "retryable" | "expired" | "unknown";
export type InteractionDraft = { selected: Record<number, string[]>; custom: Record<number, string> };
export type InteractionEntry = {
  requestId: string; sessionId: string; kind: "question" | "permission";
  generation?: number; status: InteractionStatus; draft?: InteractionDraft; errorCode?: string;
};
export function transitionInteraction(entry: InteractionEntry, status: InteractionStatus, errorCode?: string): InteractionEntry {
  return { ...entry, status, errorCode };
}
const KEY = "scikeel.interaction-drafts.v1";
const MAX_BYTES = 128 * 1024;
const TTL = 7 * 24 * 3600 * 1000;
type StoredDraft = { identity: string; updatedAt: number; draft: InteractionDraft; question?: QuestionAskedEvent };
let memory: StoredDraft[] = [];
export function interactionDraftIdentity(account: string, sessionId: string, requestId: string): string {
  return JSON.stringify([typeof location === "undefined" ? "local" : location.origin, account, sessionId, requestId]);
}
function validDraft(value: unknown): value is InteractionDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as InteractionDraft;
  if (!d.selected || !d.custom || typeof d.selected !== "object" || typeof d.custom !== "object") return false;
  return Object.entries(d.selected).length <= 50 && Object.entries(d.custom).length <= 50 &&
    Object.entries(d.selected).every(([key, v]) => /^\d{1,3}$/.test(key) && Array.isArray(v) && v.length <= 50 && v.every(x => typeof x === "string" && x.length <= 4096)) &&
    Object.entries(d.custom).every(([key, v]) => /^\d{1,3}$/.test(key) && typeof v === "string" && v.length <= 16384);
}
function read(): StoredDraft[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw && raw.length <= MAX_BYTES) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) memory = parsed.filter((v): v is StoredDraft => !!v && typeof v.identity === "string" && v.identity.length < 1024 && Number.isFinite(v.updatedAt) && validDraft(v.draft)).slice(-50);
    }
  } catch { /* Storage may be unavailable; the in-memory draft remains usable. */ }
  memory = memory.filter(v => v.updatedAt > Date.now() - TTL && v.updatedAt <= Date.now());
  return memory;
}
export function loadInteractionDraft(identity: string): InteractionDraft | undefined {
  return read().find(v => v.identity === identity)?.draft;
}
export function saveInteractionDraft(identity: string, draft?: InteractionDraft, question?: QuestionAskedEvent): void {
  memory = read().filter(v => v.identity !== identity);
  if (draft && validDraft(draft)) memory.push({ identity, updatedAt: Date.now(), draft, ...(question ? {question} : {}) });
  memory = memory.slice(-50);
  while (new TextEncoder().encode(JSON.stringify(memory)).byteLength > MAX_BYTES && memory.length) memory.shift();
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Quota/privacy fallback. */ }
}
export function interactionFailure(error: unknown): { status: InteractionStatus; code?: string } {
  const e = error as { code?: string; status?: number } | null;
  if (["QuestionNotFoundError", "PermissionNotFoundError", "interaction_expired", "runtime_context_changed"].includes(e?.code ?? "")) return { status: "expired", code: e?.code };
  // A rejected input or ownership/context preflight did not reach the mutation.
  if (e?.status && e.status < 500) return { status: "retryable", code: e.code };
  if (["session_context_unavailable", "interaction_context_unavailable", "interaction_capacity_unavailable"].includes(e?.code ?? "")) return {status:"retryable",code:e?.code};
  return { status: "unknown", code: e?.code };
}

/** Stored prompts are display-only: absence from the live list always means expired. */
export function savedQuestionDrafts(account: string): QuestionAskedEvent[] {
  return read().flatMap(v => {
    try {
      const [origin,owner,sessionId,requestId] = JSON.parse(v.identity) as string[];
      const q=v.question;
      if(origin !== (typeof location === "undefined" ? "local" : location.origin) || owner!==account ||
        !q || q.type!=="question.asked" || q.sessionId!==sessionId || q.requestId!==requestId ||
        !Array.isArray(q.questions) || q.questions.length>50 || !q.questions.every(item=>typeof item.question==="string" && typeof item.header==="string" && Array.isArray(item.options) && item.options.length<=50 && item.options.every(option=>typeof option.label==="string"))) return [];
      return [q];
    } catch { return []; }
  });
}

export function questionReceipt(messages: HistoryMessage[], request: QuestionAskedEvent, answers: string[][]): boolean {
  if (!request.tool) return false;
  const message=messages.find(m=>m.id===request.tool!.messageID);
  return !!message?.parts.some(part=>part.type==="tool" && part.tool==="question" && part.callID===request.tool!.callID &&
    part.state?.status==="completed" && JSON.stringify(part.state.metadata?.answers)===JSON.stringify(answers));
}
