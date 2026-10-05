import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { researchPaths } from "./research-tasks.mjs";
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const id = (v) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(v))
    throw fail("Invalid collaboration identifier", 400);
  return v;
};
const text = (v) => {
  if (typeof v !== "string" || !v.trim() || v.length > 12000)
    throw fail("A research answer or question is required", 400);
  return v.trim();
};
/** Gateway-owned decisions; runtime callers can propose but cannot answer. */
export class CollaborationStore {
  constructor({
    rootDir,
    now = Date.now,
    cancel = async () => {},
    running = null,
    readLegacy = null,
    research = null,
  } = {}) {
    Object.assign(this, {
      rootDir: resolve(rootDir),
      now,
      cancel,
      running,
      readLegacy,
      research,
    });
    this.records = new Map();
    this.queues = new Map();
    this.leases = new Map();
  }
  key(o) {
    return `${id(o.userId)}/${id(o.sessionId)}`;
  }
  async locked(o, fn) {
    const key = this.key(o),
      last = this.queues.get(key) ?? Promise.resolve();
    const next = last.catch(() => {}).then(fn);
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
  async save(s) {
    const folder = join(this.rootDir, id(s.userId));
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${id(s.sessionId)}.json`),
      tmp = `${path}.${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, path);
    this.records.set(this.key(s), s);
    return structuredClone(s);
  }
  async load(o) {
    const key = this.key(o);
    if (this.records.has(key)) return this.records.get(key);
    let s;
    try {
      s = JSON.parse(
        await fs.readFile(
          join(this.rootDir, id(o.userId), `${id(o.sessionId)}.json`),
          "utf8",
        ),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!s)
      s = {
        ...o,
        version: 1,
        mode: "collaborative",
        revision: 0,
        execution: 0,
        phase: "idle",
        pending: null,
        decisions: [],
      };
    if (s.userId !== o.userId || s.sessionId !== o.sessionId || s.version !== 1)
      throw fail("Invalid saved collaboration state", 500);
    this.records.set(key, s);
    if (["running", "waiting_input"].includes(s.phase)) {
      s.phase = "paused";
      s.revision++;
      await this.save(s);
    }
    return s;
  }
  get(o) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      if (
        this.readLegacy &&
        !s.legacyModeCaptured &&
        s.execution === 0 &&
        s.revision === 0
      ) {
        const legacy = await this.readLegacy(o);
        if (legacy && !legacy.executionActive) {
          s.mode = legacy.mode;
          s.legacyModeCaptured = true;
          return this.save(s);
        }
      }
      return structuredClone(s);
    });
  }
  revision(s, value) {
    if (value !== s.revision)
      throw fail("Collaboration changed; reload and retry");
  }
  setMode(o, mode, revision) {
    return this.locked(o, async () => {
      if (!["collaborative", "guided", "delegated"].includes(mode))
        throw fail("This mode is not available yet", 400);
      const s = await this.load(o);
      this.revision(s, revision);
      if (s.phase === "running")
        throw fail("Stop before changing collaboration mode");
      if (s.execution > 0 && !s.executionMode) s.executionMode = s.mode;
      s.mode = mode;
      s.revision++;
      return this.save(s);
    });
  }
  alive(o) {
    return [...(this.leases.get(this.key(o)) ?? new Map()).values()].some(
      (v) => v > this.now(),
    );
  }
  heartbeat(o, page) {
    id(page);
    const key = this.key(o);
    if (!this.leases.has(key)) this.leases.set(key, new Map());
    this.leases.get(key).set(page, this.now() + 45000);
    return this.get(o);
  }
  begin(o, revision) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      this.revision(s, revision);
      if (!["collaborative", "guided", "delegated"].includes(s.mode))
        throw fail(
          "Choose an available collaboration mode",
        );
      if (s.pending) throw fail("Research decision requires an answer");
      if (s.phase === "running")
        throw fail("Research execution is already running");
      if (!this.alive(o))
        throw fail("Open this conversation before continuing");
      Object.assign(s, o);
      s.executionMode = s.mode;
      s.execution++;
      s.startedAt = this.now();
      delete s.delivery;
      s.phase = "running";
      s.revision++;
      return this.save(s);
    });
  }
  checkpoint(o, value) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      if (!this.alive(o) || s.phase !== "running" || s.execution < 1)
        throw fail("Research execution is paused");
      if (s.pending) throw fail("Research decision requires an answer");
      if (value.execution !== undefined && value.execution !== s.execution)
        throw fail("Research execution changed");
      if (!["plan", "step", "method", "missing_input"].includes(value.kind))
        throw fail("Invalid research decision", 400);
      if (value.kind === "step" && (s.executionMode ?? s.mode) !== "guided")
        throw fail("Step confirmation requires Guided mode", 400);
      s.pending = {
        id: randomUUID(),
        execution: s.execution,
        kind: value.kind,
        question: text(value.question),
        suggestedAnswer: text(value.suggestedAnswer),
      };
      s.phase = "waiting_input";
      s.revision++;
      return this.save(s);
    });
  }
  /** Runtime proposals are checked against gateway-owned scope and file versions. */
  delivery(o, value) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      if (s.pending) throw fail("Research decision requires an answer");
      if (!this.alive(o) || s.phase !== "running")
        throw fail("Research execution is paused");
      if (value.execution !== s.execution) throw fail("Research execution changed");
      if ((s.executionMode ?? s.mode) !== "delegated")
        throw fail("Delivery verification requires Delegated mode", 400);
      if (!this.research) throw fail("Delivery verification is unavailable", 503);
      if (value.operation === "prepare") {
        const inputs = researchPaths(value.inputs ?? []);
        const deliverables = researchPaths(value.deliverables, true);
        if (s.delivery) {
          if (JSON.stringify(s.delivery.inputs.map((v) => v.path)) !== JSON.stringify(inputs) ||
              JSON.stringify(s.delivery.deliverables) !== JSON.stringify(deliverables))
            throw fail("Delivery scope is already captured; ask the user before changing it");
          return structuredClone(s);
        }
        const versions = await Promise.all(inputs.map((path) => this.research.artifact(o, path)));
        if (versions.some((v) => !v.exists)) throw fail("An original input is missing", 400);
        s.delivery = {
          execution: s.execution,
          reportPath: `.scikeel/delivery-${id(s.sessionId)}-${s.execution}.json`,
          inputs: versions, deliverables, status: "pending", attempts: 0, report: null,
        };
      } else if (value.operation === "verify") {
        const d = s.delivery;
        if (!d) throw fail("Prepare the authorized delivery scope first", 400);
        if (d.attempts >= 3 && d.status === "failed") throw fail("Delivery repair limit reached");
        const report = await this.research.readProgress({ ...o, execution: s.execution, reportPath: d.reportPath });
        const inputs = await Promise.all(d.inputs.map((v) => this.research.artifact(o, v.path)));
        const unchanged = inputs.every((v, i) => v.exists && v.sha256 === d.inputs[i].sha256);
        const outputs = d.deliverables.every((path) => report?.artifacts.some((v) => v.path === path && v.exists));
        const checks = report?.checks.length > 0 && report.checks.every((v) => v.status === "passed" && v.evidenceExists);
        const issue = !unchanged ? "changed_inputs" : !report ? "missing_progress" :
          report.decisions.length ? "pending_decisions" : report.status !== "completed" ? "incomplete_report" :
          !outputs ? "missing_outputs" : !checks ? "failed_checks" : null;
        Object.assign(d, { report, status: issue ? "failed" : "completed", issue, checkedAt: this.now() });
        d.attempts++;
      } else throw fail("Invalid delivery operation", 400);
      s.revision++;
      return this.save(s);
    });
  }
  answer(o, value) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      const answer = text(value.answer),
        previous = s.decisions.find(
          (d) => d.id === value.id && d.execution === value.execution,
        );
      if (previous) {
        if (previous.answer !== answer) throw fail("Research decision changed");
        return structuredClone(s);
      }
      this.revision(s, value.revision);
      if (
        !s.pending ||
        s.pending.id !== value.id ||
        s.pending.execution !== value.execution
      )
        throw fail("Research decision changed");
      s.decisions.push({ ...s.pending, answer, answeredAt: this.now() });
      s.pending = null;
      s.phase =
        s.phase === "waiting_input" && this.alive(o) ? "running" : "paused";
      s.revision++;
      return this.save(s);
    });
  }
  guard(o) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      return {
        blocked:
          Boolean(s.pending) ||
          s.phase === "paused" ||
          (s.execution > 0 && !this.alive(o)),
        repairExhausted: Boolean(s.delivery?.status === "failed" && s.delivery.attempts >= 3),
        state: structuredClone(s),
      };
    });
  }
  pause(o) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      if (s.phase === "paused") {
        await this.cancel(o);
        return structuredClone(s);
      }
      s.phase = "paused";
      s.revision++;
      await this.save(s);
      await this.cancel(o);
      return structuredClone(s);
    });
  }
  settled(o) {
    return this.locked(o, async () => {
      const s = await this.load(o);
      if (s.phase === "running") {
        s.phase = "idle";
        s.revision++;
        return this.save(s);
      }
      return structuredClone(s);
    });
  }
  async release(o, page) {
    this.leases.get(this.key(o))?.delete(id(page));
    const s = await this.get(o);
    if (!this.alive(o) && ["running", "waiting_input"].includes(s.phase))
      return this.pause(o);
    return s;
  }
  async tick() {
    for (const s of this.records.values()) {
      try {
        if (!["running", "waiting_input"].includes(s.phase)) continue;
        if (!this.alive(s)) await this.pause(s);
        else if (
          this.running &&
          this.now() - (s.startedAt ?? 0) > 5000 &&
          !(await this.running(s))
        )
          await this.settled(s);
      } catch {
        /* One unavailable worker cannot prevent another run from stopping. */
      }
    }
  }
  async close() {
    await Promise.allSettled(
      [...this.records.values()]
        .filter((s) => ["running", "waiting_input"].includes(s.phase))
        .map((s) => this.pause(s)),
    );
  }
}
export const COLLABORATIVE_POLICY = `SciKeel collaboration mode: collaborative. For new multi-step research, propose a concise plan and call research_checkpoint with kind plan before its execution, unless the user has already explicitly approved that plan. Execute routine steps continuously within the approved scope. Call research_checkpoint for unapproved substantive method choices or missing essential inputs. Simple questions and explicitly requested single operations need no plan. Discuss-only requests permit no execution. The checkpoint answer is the user's decision; suggestions are not approval. Existing tool permissions remain unchanged. Preserve original inputs and use relevant scientific Skills. Never invent outputs, citations, verification or novelty.`;

export const GUIDED_POLICY = `SciKeel collaboration mode: guided. For multi-step research, explain one meaningful research outcome at a time: why it matters, what will be done, and how its result will be checked. Before each unapproved step, call research_checkpoint with kind step and WAIT for the user's real answer. Explicit approval in the conversation authorizes that step without asking twice; approval of an overall plan does not approve every subsequent step. Execute routine reads, tool calls, analysis and bounded repairs continuously within the confirmed step. After completing it, explain its actual result and evidence, then describe the next outcome and call research_checkpoint with kind step before starting that next outcome. A meaningful step is an outcome such as inspecting data, choosing a method, running analysis or interpreting results, not each tool call or sentence. When the requested final outcome is complete, deliver it without an empty next-step checkpoint. Simple questions, concept explanations and an explicitly requested single operation need no ceremonial plan. Discuss-only requests permit no execution. Call research_checkpoint for unapproved substantive method choices or missing essential inputs. Suggested answers are not approval. Existing tool permissions remain unchanged. Preserve original inputs, use relevant scientific Skills and never invent outputs, citations or verification.`;
export const DELEGATED_POLICY = `SciKeel collaboration mode: delegated (Basic Delegated, Stage 3). Execute a clear, explicitly authorized scope continuously without a ceremonial plan or meaningful-step confirmation. Follow confirmed methods and alternatives; call research_checkpoint with kind method before an unapproved substantive choice such as the primary analysis method, observation exclusions or a changed research question. Stage 3 does not grant broad initial method-selection authority. Call research_checkpoint with kind missing_input for essential unavailable materials. Discuss-only requests permit no execution; simple questions and explicitly requested single operations need no research report. Give brief nonblocking progress. Preserve original inputs and use relevant scientific Skills. For multi-step work that produces requested files, call research_delivery action prepare with actual original input paths and promised deliverable paths before changes, using only workspace-relative paths. It returns execution and reportPath. Write the existing version-1 research report there: {version:1,execution,status:completed|running|failed,steps:[],decisions:[],artifacts:[relative paths],checks:[{title,status:passed|failed|pending,evidence:relative evidence file}],limitations:string}. Checks require actual executions and evidence files. Then call research_delivery action verify. Deliver success only if the verification status is completed; a filename alone is not an output. Repair within the same scope at most twice after the initial failed candidate; never change originals, widen scope or repeat a failing operation indefinitely. If repair is exhausted or impossible, stop and explain partial outputs, failed checks and the blocker accurately. Completion verifies file/evidence presence and unchanged original versions; scientific check conclusions are Agent-reported self-checks, not independent review, novelty or publication readiness. Never invent data, citations, outputs or passed checks. Only real authenticated user answers approve research decisions; suggestions and reports cannot approve them. Existing operation permissions and page-bound execution remain unchanged.`;
/** A preference change during waiting applies only to the next execution. */
export function collaborationPolicy(state) {
  const mode = state.execution > 0 ? state.executionMode ?? state.mode : state.mode;
  return mode === "guided" ? GUIDED_POLICY : mode === "delegated" ? DELEGATED_POLICY : COLLABORATIVE_POLICY;
}
