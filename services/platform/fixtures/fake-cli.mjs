const [runtime] = process.argv.slice(2);
const args = process.argv.slice(3);
const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] ?? "" : args.at(-1) ?? "";

function requiredModel() {
  const index = args.indexOf("--model");
  const model = index >= 0 ? args[index + 1] : null;
  if (!model) {
    process.stderr.write("fake cli: missing --model\n");
    process.exit(2);
  }
  return { index, model };
}

if (runtime === "claude") {
  const { model } = requiredModel();
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-native-session" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: "claude-native-session", message: { role: "assistant", content: [{ type: "text", text: `Claude[${model}]: ${prompt}` }] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "claude-native-session", result: `Claude[${model}]: ${prompt}` })}\n`);
  process.exit(0);
}

if (runtime === "codex") {
  const { index: modelIndex, model } = requiredModel();
  const resumeIndex = args.indexOf("resume");
  if (resumeIndex >= 0) {
    const misplaced = args.slice(resumeIndex + 1).find((arg) => arg === "-C" || arg === "-s" || arg === "--model");
    if (misplaced) {
      process.stderr.write(`fake codex: unexpected argument '${misplaced}' after resume\n`);
      process.exit(2);
    }
    if (modelIndex > resumeIndex) {
      process.stderr.write("fake codex: --model must appear before resume\n");
      process.exit(2);
    }
  }
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-native-session" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: `Codex[${model}]: ${prompt}` } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  process.exit(0);
}

process.stderr.write("fake cli: unknown runtime\n");
process.exit(2);
