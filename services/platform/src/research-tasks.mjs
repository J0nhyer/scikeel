import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const MODES = new Set(["guided", "collaborative", "delegated"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const LEASE_MS = 45_000;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const inside = (root, file) => {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
};
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) throw error("invalid research identifier");
  return value;
}
function text(value, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw error("a nonempty research value is required");
  return value.trim();
}
function filePath(value) {
  const path = text(value, 500);
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((p) => p === ".." || p === "." || !p)) {
    throw error("research files must use workspace-relative paths");
  }
  return path;
}
function paths(values, required = false) {
  if (!Array.isArray(values) || values.length > 30 || required && !values.length) throw error("research file list is invalid");
  return [...new Set(values.map(filePath))];
}
function mode(value) {
  if (!MODES.has(value)) throw error("invalid research mode");
  return value;
}
async function safeFile(directory, path) {
  try {
    const root = await fs.realpath(directory);
    if (root !== resolve(directory)) return null;
    const actual = await fs.realpath(join(root, filePath(path)));
    if (!inside(root, actual) || !(await fs.stat(actual)).isFile()) return null;
    return actual;
  } catch { return null; }
}
async function artifact(directory, path) {
  const actual = await safeFile(directory, path);
  if (!actual) return { path, exists: false, sha256: null };
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(actual)) hash.update(chunk);
  return { path, exists: true, sha256: hash.digest("hex") };
}

/** One durable brief per conversation. Page leases are deliberately ephemeral. */
export class ResearchTasks {
  constructor({ rootDir, cancel = async () => {}, running = null, now = Date.now, logger = () => {}, workspace = null } = {}) {
    this.rootDir = resolve(rootDir);
    this.workspace = workspace;
    this.cancel = cancel;
    this.running = running;
    this.logger = logger;
    this.now = now;
    this.records = new Map();
    this.leases = new Map();
    this.queues = new Map();
  }
  artifact(owner, path) {return this.workspace ? this.workspace.artifact(owner,path) : artifact(owner.directory,path);}
  async evidence(owner,path) {return this.workspace ? (await this.workspace.artifact(owner,path)).exists : Boolean(await safeFile(owner.directory,path));}
  key(userId, sessionId) { return `${id(userId)}/${id(sessionId)}`; }
  async locked(userId, sessionId, fn) {
    const key = this.key(userId, sessionId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    this.queues.set(key, work);
    try { return await work; }
    finally { if (this.queues.get(key) === work) this.queues.delete(key); }
  }
  async save(task) {
    const folder = join(this.rootDir, id(task.userId));
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${id(task.sessionId)}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(task), { mode: 0o600 });
    await fs.rename(temp, file);
    this.records.set(this.key(task.userId, task.sessionId), task);
    return structuredClone(task);
  }
  async load(userId, sessionId) {
    const key = this.key(userId, sessionId);
    if (this.records.has(key)) return this.records.get(key);
    let task;
    try { task = JSON.parse(await fs.readFile(join(this.rootDir, id(userId), `${id(sessionId)}.json`), "utf8")); }
    catch (err) { if (err.code === "ENOENT") return null; throw err; }
    if (task.userId !== userId || task.sessionId !== sessionId || task.version !== 1) throw error("invalid saved research task", 500);
    this.records.set(key, task);
    if (task.executionActive || task.status === "running") {
      await this.cancel(task);
      task.executionActive = false;
      task.status = "paused";
      task.stopReason = "server-restarted";
      await this.save(task);
    }
    return task;
  }
  async get(userId, sessionId) {
    return this.locked(userId, sessionId, async () => structuredClone(await this.load(userId, sessionId)));
  }
  async create(owner, brief) {
    // Validate before checking for an existing record, so invalid retries fail.
    const objective = text(brief.objective);
    const selected = mode(brief.mode ?? "collaborative");
    const inputs = paths(brief.inputs ?? []);
    const deliverables = paths(brief.deliverables, true);
    const pageId = id(brief.pageId);
    if (!["thesis", "publication"].includes(brief.goal)) throw error("invalid research goal");
    const {directory,workspaceDir} = this.workspace ? await this.workspace.normalize(owner) :
      {directory:await fs.realpath(owner.directory),workspaceDir:await fs.realpath(owner.workspaceDir)};
    if (!inside(workspaceDir, directory)) throw error("research session is outside the owning workspace", 403);
    return this.locked(owner.userId, owner.sessionId, async () => {
      if (await this.load(owner.userId, owner.sessionId)) throw error("this conversation already has a research task", 409);
      if (deliverables.some((p) => inputs.includes(p))) throw error("original inputs cannot also be output files");
      const protocol = join(directory, ".scikeel");
      if(this.workspace)await this.workspace.prepare(owner);
      else {
        await fs.mkdir(protocol, { recursive: true, mode: 0o700 });
        if (!inside(directory, await fs.realpath(protocol))) throw error("research report folder is outside the session workspace", 403);
      }
      const task = {
        version: 1, ...owner, directory, workspaceDir, objective, goal: brief.goal,
        mode: selected, inputs, deliverables, inputVersions: await Promise.all(inputs.map((p) => this.artifact(owner, p))), decisions: [],
        skills: [{ name: "research-workflow", version: "1" }],
        authorization: "existing-runtime-workspace-policy", status: "ready",
        execution: 0, executionActive: false, revision: 1, createdAt: this.now(), updatedAt: this.now(),
        reportPath: `.scikeel/research-${id(owner.sessionId)}.json`, report: null,
      };
      this.leases.set(this.key(owner.userId, owner.sessionId), new Map([[pageId, this.now() + LEASE_MS]]));
      return this.save(task);
    });
  }
  pending(task) {
    return (task.report?.decisions ?? []).filter((d) => !task.decisions.some((confirmed) => confirmed.id === d.id && confirmed.question === d.question));
  }
  async readProgress(task) {
    let report;
    try {
      let text;
      if(this.workspace)text=await this.workspace.readReport(task,task.reportPath);
      else {const file=await safeFile(task.directory,task.reportPath);if(!file || (await fs.stat(file)).size>128*1024)return null;
        text=await fs.readFile(file,"utf8");}
      if(text===null)return null;report=JSON.parse(text);
    } catch {return null;}
    if (report.version !== 1 || report.execution !== task.execution || !["running", "waiting_input", "completed", "failed"].includes(report.status)) return null;
    try {
      const decisions = (report.decisions ?? []).slice(0, 20).map((d) => ({ id: id(d.id), question: text(d.question) }));
      if (new Set(decisions.map((d) => d.id)).size !== decisions.length) return null;
      const steps = (report.steps ?? []).slice(0, 30).map((step) => ({ title: text(step.title, 500), status: ["pending", "running", "completed", "failed"].includes(step.status) ? step.status : "pending" }));
      const artifacts = await Promise.all(paths(report.artifacts ?? []).map((p) => this.artifact(task, p)));
      const checks = await Promise.all((report.checks ?? []).slice(0, 30).map(async (check) => ({
        title: text(check.title, 500), status: ["passed", "failed", "pending"].includes(check.status) ? check.status : "pending",
        evidence: check.evidence ? filePath(check.evidence) : null,
        evidenceExists: Boolean(check.evidence && await this.evidence(task, check.evidence)),
      })));
      return { steps, decisions, artifacts, checks, status: report.status, limitations: typeof report.limitations === "string" ? report.limitations.slice(0, 4000) : "" };
    } catch { return null; }
  }
  async refreshUnlocked(task) {
    if (!task) return null;
    task.report = await this.readProgress(task);
    delete task.issue;
    if (task.report && !["paused", "cancelled"].includes(task.status)) {
      if (this.pending(task).length) {
        if (task.executionActive) {
          await this.cancel(task);
          task.executionActive = false;
        }
        task.status = "waiting_input";
      }
      else if (task.report.status === "completed") {
        const outputs = task.deliverables.every((p) => task.report.artifacts.some((a) => a.path === p && a.exists));
        const checks = task.report.checks.length > 0 && task.report.checks.every((c) => c.status === "passed" && c.evidenceExists);
        const currentInputs = await Promise.all(task.inputs.map((p) => this.artifact(task, p)));
        const inputsUnchanged = currentInputs.every((current) => current.exists && task.inputVersions?.some((original) => original.path === current.path && original.sha256 === current.sha256));
        if (!inputsUnchanged) task.report.limitations = [task.report.limitations, "An original input is missing or changed; inspect the input versions before accepting the results."].filter(Boolean).join("\n");
        task.status = outputs && checks && inputsUnchanged ? "completed" : "failed";
        if (task.status === "failed") task.issue = !inputsUnchanged ? "changed_inputs" : !outputs ? "missing_outputs" : "failed_checks";
      } else if (task.report.status === "waiting_input") task.status = "ready";
      else task.status = task.report.status;
    }
    if (task.execution > 0 && !task.executionActive && !["paused", "cancelled"].includes(task.status) && (!task.report || task.report.status === "running")) {
      task.status = "failed";
      task.issue = "missing_progress";
    }
    task.updatedAt = this.now();
    return this.save(task);
  }
  async refresh(userId, sessionId) {
    return this.locked(userId, sessionId, async () => this.refreshUnlocked(await this.load(userId, sessionId)));
  }
  alive(userId, sessionId) {
    const pages = this.leases.get(this.key(userId, sessionId));
    return pages && [...pages.values()].some((until) => until > this.now());
  }
  async heartbeat(userId, sessionId, pageId) {
    id(pageId);
    return this.locked(userId, sessionId, async () => {
      const task = await this.load(userId, sessionId);
      if (!task) throw error("research task not found", 404);
      const key = this.key(userId, sessionId);
      if (!this.leases.has(key)) this.leases.set(key, new Map());
      this.leases.get(key).set(pageId, this.now() + LEASE_MS);
      return structuredClone(task);
    });
  }
  async stop(task, reason = "user-stopped") {
    await this.cancel(task);
    task.executionActive = false;
    task.status = "paused";
    task.stopReason = reason;
    task.updatedAt = this.now();
    return this.save(task);
  }
  async release(userId, sessionId, pageId) {
    return this.locked(userId, sessionId, async () => {
      const task = await this.load(userId, sessionId);
      this.leases.get(this.key(userId, sessionId))?.delete(id(pageId));
      if (task?.executionActive && !this.alive(userId, sessionId)) return this.stop(task, "page-closed");
      if (task && !this.alive(userId, sessionId)) await this.cancel(task);
      return structuredClone(task);
    });
  }
  async action(userId, sessionId, payload) {
    return this.locked(userId, sessionId, async () => {
      const task = await this.load(userId, sessionId);
      if (!task) throw error("research task not found", 404);
      if (payload.action === "stop") return this.stop(task);
      if (payload.action === "mode") {
        if (task.executionActive) throw error("cannot change mode while research is running", 409);
        task.mode = mode(payload.mode);
      } else if (payload.action === "decide") {
        await this.refreshUnlocked(task);
        const decision = this.pending(task).find((d) => d.id === payload.id);
        if (!decision) throw error("pending research decision not found", 409);
        task.decisions.push({ ...decision, answer: text(payload.answer), execution: task.execution, confirmedAt: this.now() });
        task.status = this.pending(task).length ? "waiting_input" : "ready";
      } else throw error("invalid research action");
      task.revision++;
      return this.save(task);
    });
  }
  async prepare(userId, sessionId, body) {
    return this.locked(userId, sessionId, async () => {
      const task = await this.load(userId, sessionId);
      if (!task) return null;
      if (!this.alive(userId, sessionId)) throw error("open the research page before starting a task", 409);
      if (task.executionActive) {
        if (this.running && !await this.running(task)) task.executionActive = false;
        else throw error("research task is already running", 409);
      }
      await this.refreshUnlocked(task);
      if (this.pending(task).length) throw error("confirm the pending research decision before continuing", 409);
      for (let index = 0; index < task.inputVersions.length; index++) {
        if (!task.inputVersions[index].exists) task.inputVersions[index] = await this.artifact(task, task.inputVersions[index].path);
      }
      task.execution++;
      task.executionActive = true;
      task.status = "running";
      task.report = null;
      delete task.stopReason;
      await this.save(task);
      const policy = {
        guided: "Explain the next meaningful step and its purpose. Execute only that step, then record a decision asking the student whether to proceed. Ask about substantive method choices before implementing them.",
        collaborative: "Propose a concrete plan first and record a decision for confirmation. After confirmation, perform its routine steps continuously. Pause and record a decision for material method changes or missing inputs.",
        delegated: "Execute the confirmed objective and deliverables continuously, checking each outcome. Repair execution errors at most twice. Pause for missing inputs or unapproved changes to the research question or scientific method.",
      }[task.mode];
      const context = `SciKeel research task (version 1). Use the research-workflow Skill and relevant scientific Skills.\n${JSON.stringify(task)}\nMode policy: ${policy}\nExisting runtime tool permissions still apply; this mode grants no new permissions. Preserve original inputs. Never fabricate data or citations.\nWrite progress atomically to ${task.reportPath} inside this session workspace, using:\n${JSON.stringify({ version: 1, execution: task.execution, status: "running", steps: [{ title: "Actual research step", status: "pending" }], decisions: [], artifacts: [], checks: [], limitations: "" })}\nAllowed report status: running, waiting_input, completed, failed. Decisions: {id,question}; only user confirmations in the task record are confirmed decisions. Artifacts: relative file paths, including every requested deliverable. Checks: {title,status: passed|failed|pending,evidence: relative path to actual check output}. A completed report needs existing outputs and passed checks with evidence. Record missing inputs and limitations explicitly. Write waiting_input before stopping for a research decision; do not execute beyond that decision. Explain the result to the student, never claim publication readiness.\nUser request:\n`;
      const original = Array.isArray(body.parts) ? body.parts : [];
      return { ...body, system: [typeof body.system === "string" ? body.system : "", context].filter(Boolean).join("\n\n"), parts: original };
    });
  }
  async settled(userId, sessionId) {
    return this.locked(userId, sessionId, async () => {
      const task = await this.load(userId, sessionId);
      if (!task) return null;
      task.executionActive = false;
      await this.refreshUnlocked(task);
      return this.save(task);
    });
  }
  async tick() {
    for (const task of this.records.values()) {
      try {
        await this.locked(task.userId, task.sessionId, async () => {
          if (!task.executionActive && this.running && await this.running(task)) task.executionActive = true;
          if (!task.executionActive) return;
          if (!this.alive(task.userId, task.sessionId)) await this.stop(task, "page-timeout");
          else {
            if (this.running && !await this.running(task)) task.executionActive = false;
            await this.refreshUnlocked(task);
          }
        });
      } catch (error) {
        this.logger({ type: "research.monitor_error", error: error.message });
      }
    }
  }
  async close() {
    await Promise.all([...this.records.values()].filter((task) => task.executionActive).map((task) => this.stop(task, "server-stopped")));
  }
}
