import { gatewayOrigin } from "./webMode";

export type ResearchMode = "guided" | "collaborative" | "delegated";
export interface ResearchBrief {
  objective: string;
  goal: "thesis" | "publication";
  mode: ResearchMode;
  inputs: string[];
  deliverables: string[];
  pageId: string;
}
export interface ResearchTask extends Omit<ResearchBrief, "pageId"> {
  sessionId: string;
  directory: string;
  status: "ready" | "running" | "waiting_input" | "paused" | "completed" | "failed" | "cancelled";
  executionActive: boolean;
  execution: number;
  issue?: "changed_inputs" | "missing_outputs" | "failed_checks" | "missing_progress";
  decisions: Array<{ id: string; question: string; answer: string }>;
  report: null | {
    steps: Array<{ title: string; status: "pending" | "running" | "completed" | "failed" }>;
    decisions: Array<{ id: string; question: string }>;
    artifacts: Array<{ path: string; exists: boolean; sha256: string | null }>;
    checks: Array<{ title: string; status: "passed" | "failed" | "pending"; evidence: string | null; evidenceExists: boolean }>;
    limitations: string;
  };
}
// getRandomValues is available on HTTP too; randomUUID requires a secure context.
export const researchPageId = `page-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export async function researchRequest(sessionId: string, payload?: unknown, keepalive = false): Promise<ResearchTask | null> {
  const result = await fetch(`${gatewayOrigin()}/api/research/${encodeURIComponent(sessionId)}`, {
    credentials: "same-origin",
    ...(payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    keepalive,
  });
  const body = await result.json();
  if (!result.ok) throw new Error(body.error ?? `HTTP ${result.status}`);
  return body.task;
}
export function createResearchTask(sessionId: string, brief: ResearchBrief) {
  return researchRequest(sessionId, { action: "create", ...brief });
}
