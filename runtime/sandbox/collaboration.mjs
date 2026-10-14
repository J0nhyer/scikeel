import { readToolError, ToolOutcomeError } from "./tool-outcome.mjs";
/** Trusted plugin options carry only the existing scoped broker token. */
export function collaborationHooks({ token, request: provided }) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid collaboration bridge");
  const request =
    provided ??
    (async (sessionId, body, signal) => {
      const response = await fetch("http://172.31.240.1:4792/collaboration", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, ...body }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        // Cap bytes while reading: a malicious upstream must not allocate an unbounded body.
        const reader = response.body?.getReader();
        const chunks = []; let bytes = 0;
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 8192) { await reader.cancel(); break; }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
        const text = bytes <= 8192 ? new TextDecoder().decode(Uint8Array.from(chunks.flatMap(value => [...value]))) : "";
        const outcome = readToolError(text);
        if (outcome) throw new ToolOutcomeError(outcome);
        throw new Error("Research checkpoint service unavailable");
      }
      return response.json();
    });
  const registrations = new Map(),
    deliveries = new Map(),
    preflight = new Map();
  const before = async (input, output) => {
    const key = input.sessionID,
      last = preflight.get(key) ?? Promise.resolve();
    const next = last
      .catch(() => {})
      .then(async () => {
        const result = await request(key, { action: "guard" });
        if (result.blocked)
          throw new Error("Research decision requires an answer");
        if (result.repairExhausted)
          throw new Error("Delivery repair limit reached; explain the partial outcome");
        if (input.tool === "research_delivery") {
          const saved = await request(key, {
            action: "delivery", callId: input.callID, operation: output.args.action,
            execution: result.state.execution,
            inputs: output.args.inputs, deliverables: output.args.deliverables,
          });
          deliveries.set(`${key}/${input.callID}`, saved);
        }
        if (input.tool === "research_checkpoint") {
          const registered = await request(key, {
            action: "checkpoint",
            ...output.args, callId: input.callID,
          });
          registrations.set(`${key}/${input.callID}`, registered);
        }
      });
    preflight.set(key, next);
    try {
      await next;
    } finally {
      if (preflight.get(key) === next) preflight.delete(key);
    }
  };
  const checkpoint = {
    description:
      "Request and WAIT for the user research decision before continuing. Use for a new research plan, next meaningful Guided step, or unapproved substantive method choice. Never assume approval.",
    args: {
      kind: { type: "string", enum: ["plan", "step", "method", "missing_input"] },
      question: { type: "string", minLength: 1, maxLength: 12000 },
      suggestedAnswer: { type: "string", minLength: 1, maxLength: 12000 },
    },
    async execute(args, context) {
      const key = `${context.sessionID}/${context.callID}`;
      const first =
        registrations.get(key) ??
        (await request(
          context.sessionID,
          { action: "checkpoint", ...args, callId: context.callID },
          context.abort,
        ));
      registrations.delete(key);
      const pending = first.state.pending;
      for (;;) {
        context.abort?.throwIfAborted();
        const { state } = await request(
          context.sessionID,
          { action: "state" },
          context.abort,
        );
        if (state.phase === "paused" || state.execution !== pending.execution)
          throw new Error("Research execution paused");
        const answer = state.decisions.find(
          (d) => d.id === pending.id && d.execution === pending.execution,
        );
        if (answer)
          return JSON.stringify({
            decision: pending.id,
            userAnswer: answer.answer,
          });
        await new Promise((resolve, reject) => {
          const signal = context.abort;
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 1000);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
    },
  };
  const delivery = {
    description: "Prepare an explicitly authorized Basic Delegated file scope before editing originals or producing outputs, then verify its version-1 report against actual workspace files. At most two repairs after the first failed candidate. The result checks files and evidence, not scientific correctness.",
    args: {
      action: { type: "string", enum: ["prepare", "verify"] },
      inputs: { type: "array", items: { type: "string" }, maxItems: 30 },
      deliverables: { type: "array", items: { type: "string" }, maxItems: 30 },
    },
    async execute(args, context) {
      const key = `${context.sessionID}/${context.callID}`;
      let saved = deliveries.get(key);
      deliveries.delete(key);
      if (!saved) {
        const guarded = await request(context.sessionID, { action: "guard" }, context.abort);
        if (guarded.blocked) throw new Error("Research decision requires an answer");
        if (guarded.repairExhausted) throw new Error("Delivery repair limit reached");
        saved = await request(context.sessionID, {
          action: "delivery", callId: context.callID, operation: args.action, execution: guarded.state.execution,
          inputs: args.inputs, deliverables: args.deliverables,
        }, context.abort);
      }
      return JSON.stringify({ execution: saved.state.execution, delivery: saved.state.delivery });
    },
  };
  return {
    "tool.execute.before": before,
    tool: { research_checkpoint: checkpoint, research_delivery: delivery },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const result = await request(input.sessionID, { action: "guard" });
      if (result.blocked)
        throw new Error("Research decision requires an answer");
      if (result.state?.execution > 0 && result.policy)
        output.system.push(
          result.policy,
          `Confirmed research decisions: ${JSON.stringify(result.state.decisions)}`,
          `Delivery verification: ${JSON.stringify(result.state.delivery ?? null)}`,
          ...(result.repairExhausted ? ["Delivery repair limit reached. Make no further tool calls. Explain the failed checks, preserved partial outputs and limitations truthfully."] : []),
        );
    },
  };
}
