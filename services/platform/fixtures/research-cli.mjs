import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

// Deterministic integration fixture; no model calls or scientific claims.
const args = process.argv.slice(2);
const prompt = args.at(-1);
const match = prompt.match(/SciKeel research task \(version 1\)[^\n]*\n([^\n]+)/);
if (!match) throw new Error("missing research context");
const task = JSON.parse(match[1]);
const directory = task.directory;
const report = { version: 1, execution: task.execution, status: "running", steps: [{ title: "Inspect source data and report the actual mean", status: "running" }], decisions: [], artifacts: [], checks: [], limitations: "Deterministic browser integration fixture, not a model evaluation." };
const save = async () => {
  const file = join(directory, task.reportPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(report));
  await rename(`${file}.tmp`, file);
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: "thread.started", thread_id: "research-fixture-thread" });

if (task.objective.includes("long-running")) {
  await save();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await writeFile(join(directory, "child.pid"), String(child.pid));
  emit({ type: "item.completed", item: { id: "progress", type: "agent_message", text: "Running the confirmed research task." } });
  setInterval(() => {}, 1000);
} else if (task.mode !== "delegated" && !task.decisions.some((d) => d.id === "plan")) {
  report.status = "waiting_input";
  report.decisions = [{ id: "plan", question: "Confirm computing the mean from the supplied CSV?" }];
  report.steps[0].status = "pending";
  await save();
  emit({ type: "item.completed", item: { id: "plan", type: "agent_message", text: "I propose reading the supplied data, computing the mean, and saving the report and check evidence. Please confirm this plan." } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  const values = (await readFile(join(directory, task.inputs[0]), "utf8")).trim().split("\n").slice(1).map(Number);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const output = task.deliverables[0];
  await mkdir(dirname(join(directory, output)), { recursive: true });
  await writeFile(join(directory, output), `# Baseline research report\n\nMean: ${mean}\n\nComputed from ${task.inputs[0]} using ${values.length} observations.\n`);
  await writeFile(join(directory, "verification.txt"), `Read ${values.length} rows; actual mean ${mean}; expected fixture mean 2; equal: ${mean === 2}.\n`);
  report.status = "completed";
  report.steps[0].status = "completed";
  report.artifacts = [output];
  report.checks = [{ title: "Mean matches the executed fixture calculation", status: mean === 2 ? "passed" : "failed", evidence: "verification.txt" }];
  await save();
  emit({ type: "item.completed", item: { id: "report", type: "agent_message", text: `The data mean is ${mean}. Saved ${output} and verification.txt. This demonstrates reproducible calculation, not publication readiness.` } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}
