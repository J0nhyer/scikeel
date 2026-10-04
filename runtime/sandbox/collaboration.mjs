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
      if (!response.ok)
        throw new Error("Research checkpoint service unavailable");
      return response.json();
    });
  const registrations = new Map(),
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
        if (input.tool === "research_checkpoint") {
          const registered = await request(key, {
            action: "checkpoint",
            ...output.args,
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
          { action: "checkpoint", ...args },
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
  return {
    "tool.execute.before": before,
    tool: { research_checkpoint: checkpoint },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const result = await request(input.sessionID, { action: "guard" });
      if (result.blocked)
        throw new Error("Research decision requires an answer");
      if (result.state?.execution > 0 && result.policy)
        output.system.push(
          result.policy,
          `Confirmed research decisions: ${JSON.stringify(result.state.decisions)}`,
        );
    },
  };
}
