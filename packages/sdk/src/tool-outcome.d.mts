import type { ToolOutcome, ToolOutcomeCode } from "@ai4s/shared";
export const OUTCOME_DESCRIPTORS: Readonly<Record<ToolOutcomeCode, Readonly<Pick<ToolOutcome, "category" | "message" | "nextAction" | "retry">>>>;
export function makeToolOutcome(code: ToolOutcomeCode, options: Pick<ToolOutcome, "source" | "correlationId"> & Partial<Pick<ToolOutcome, "status" | "details">>): ToolOutcome;
export class ToolOutcomeError extends Error { constructor(outcome: ToolOutcome); code: ToolOutcomeCode; status?: number; outcome: ToolOutcome; }
export function serializeToolError(outcome: ToolOutcome): { error: ToolOutcome };
export function readToolError(text: unknown): ToolOutcome | null;
export function normalizeToolResult(tool: string, state?: { status?: string; error?: unknown; metadata?: { scikeelOutcome?: unknown } }, callId?: string): { status: import("@ai4s/shared").ToolCallStatus; error?: string; outcome?: ToolOutcome };

export function isToolCallId(value: unknown): value is string;
