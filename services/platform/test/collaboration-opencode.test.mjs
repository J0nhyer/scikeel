import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CollaborationStore } from "../src/collaboration.mjs";
const binary =
  process.env.OSD_COLLABORATION_BINARY ??
  "/var/lib/scikeel/images/1f1699c60f57521fc2d80885787156b18b4de6930dffaf06396282f69fb93cb0/rootfs/opt/scikeel/tools/bin/opencode";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => false);
    if (value) return value;
    await delay(100);
  }
  throw new Error("Runtime acceptance timed out");
}
for (const mode of ["collaborative", "guided", "delegated"]) test(
  `pinned OpenCode ${mode} waits at each required checkpoint before writing an actual artifact`,
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "scikeel-collab-native-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(
      join(root, ".npmrc"),
      "registry=http://127.0.0.1:1\nfetch-retries=0\nfetch-timeout=1000\n",
    );
    await writeFile(join(workspace, ".gitignore"), "");
    const owner = {
      userId: "fixture",
      sessionId: "pending",
      runtime: "opencode",
      directory: workspace,
      workspaceDir: workspace,
    };
    const store = new CollaborationStore({ rootDir: join(root, "records") });
    let calls = 0;
    let captured = [];
    const server = createServer(async (req, res) => {
      const buffers = [];
      for await (const b of req) buffers.push(b);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      if (req.url === "/bridge") {
        const o = { ...owner, sessionId: body.sessionId };
        let result;
        if (body.action === "checkpoint")
          result = { state: await store.checkpoint(o, body) };
        else if (body.action === "state")
          result = { state: await store.get(o) };
        else result = await store.guard(o);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      captured.push(body);
      const hasCheckpoint = body.tools?.some(
        (tool) => tool.function?.name === "research_checkpoint",
      );
      const finish = body.messages.some(
        (m) =>
          m.role === "tool" &&
          (m.tool_call_id === "call_write" ||
            String(m.content).includes("successfully")),
      );
      const checkpointAnswered = body.messages.some(
        (m) => m.role === "tool" && String(m.content).includes("userAnswer"),
      );
      const nextStepAnswered = body.messages.some(
        (m) => m.role === "tool" && m.tool_call_id === "call_next_step" && String(m.content).includes("userAnswer"),
      );
      let delta,
        reason = "stop";
      if (hasCheckpoint && !finish) {
        reason = "tool_calls";
        if (!checkpointAnswered)
          delta = {
            tool_calls: [
              {
                index: 0,
                id: "call_decision",
                type: "function",
                function: {
                  name: "research_checkpoint",
                  arguments: JSON.stringify({
                    kind: mode === "guided" ? "step" : mode === "delegated" ? "method" : "plan",
                    question: "Write result.txt and verify?",
                    suggestedAnswer: "Continue",
                  }),
                },
              },
              {
                index: 1,
                id: "call_early_write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    filePath: join(workspace, "result.txt"),
                    content: "unapproved artifact",
                  }),
                },
              },
            ],
          };
        else if (mode === "guided" && !nextStepAnswered)
          delta = {
            tool_calls: [{ index: 0, id: "call_next_step", type: "function", function: {
              name: "research_checkpoint", arguments: JSON.stringify({ kind: "step",
                question: "Inspection completed. Write and verify the actual artifact next?",
                suggestedAnswer: "Write the verified artifact" }),
            } }, { index: 1, id: "call_second_early_write", type: "function", function: {
              name: "write", arguments: JSON.stringify({ filePath: join(workspace, "result.txt"), content: "second unapproved artifact" }),
            } }],
          };
        else
          delta = {
            tool_calls: [
              {
                index: 0,
                id: "call_write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    filePath: join(workspace, "result.txt"),
                    content: "verified artifact\n",
                  }),
                },
              },
            ],
          };
        calls++;
      } else delta = { content: "Completed" };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [d, f] of [
          [delta, null],
          [{}, reason],
        ])
          res.write(
            `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "completion",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Fixture", ...delta },
                finish_reason: reason,
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }),
        );
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pluginPath = join(root, "plugin.mjs");
    await writeFile(
      pluginPath,
      `import {collaborationHooks} from ${JSON.stringify(pathToFileURL(resolve(new URL("../../../runtime/sandbox/collaboration.mjs", import.meta.url).pathname)).href)};export default async()=>collaborationHooks({token:'a'.repeat(64),request:async(sessionId,body)=>{const r=await fetch('${origin}/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,...body})});return r.json();}});`,
    );
    const cfg = join(root, "config");
    await mkdir(join(cfg, "opencode"), { recursive: true });
    await writeFile(
      join(cfg, "opencode/opencode.json"),
      JSON.stringify({
        plugin: [pluginPath],
        model: "fixture/fixture",
        permission: { edit: "ask", bash: "ask", external_directory: "deny" },
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "fixture",
            options: { baseURL: `${origin}/v1`, apiKey: "synthetic" },
            models: {
              fixture: {
                name: "fixture",
                limit: { context: 32000, output: 4000 },
              },
            },
          },
        },
      }),
    );
    const portServer = createServer();
    await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
    const port = portServer.address().port;
    await new Promise((r) => portServer.close(r));
    const native = `http://127.0.0.1:${port}`;
    const child = spawn(
      binary,
      [
        "--print-logs",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: cfg,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_SERVER_PASSWORD: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    let diagnostic = "";
    child.stderr.on("data", (b) => (diagnostic += b.toString()));
    t.after(async () => {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        delay(2000),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    let step = "health",
      lastHealth = "";
    const nativeFetch = (url, options = {}) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
    try {
      await waitFor(async () => {
        const r = await nativeFetch(`${native}/session`);
        lastHealth = `${r.status} ${await r.text()}`;
        return r.ok;
      });
      step = "session";
      const session = await (
        await nativeFetch(`${native}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      step = "prompt";
      owner.sessionId = session.id;
      await store.heartbeat(owner, "page");
      const selection = mode === "guided" ? await store.setMode(owner, mode, 0) : await store.get(owner);
      await store.begin(owner, selection.revision);
      const post = await nativeFetch(
        `${native}/session/${session.id}/prompt_async`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parts: [
              {
                type: "text",
                text: "Propose the plan and call research_checkpoint, then write result.txt.",
              },
            ],
          }),
        },
      );
      assert.equal(post.status, 204);
      step = "checkpoint";
      const waiting = await waitFor(async () => {
        const s = await store.get(owner);
        return s.pending ? s : false;
      });
      await delay(250);
      assert.equal(existsSync(join(workspace, "result.txt")), false);
      assert.equal(calls, 1);
      assert.deepEqual(
        await (await nativeFetch(`${native}/permission`)).json(),
        [],
      );
      await store.answer(owner, {
        id: waiting.pending.id,
        execution: waiting.execution,
        revision: waiting.revision,
        answer: "Continue",
      });
      if (mode === "guided") {
        step = "next-step";
        const next = await waitFor(async () => { const state = await store.get(owner); return state.pending && state.pending.id !== waiting.pending.id ? state : false; });
        await delay(250);
        assert.equal(next.pending.kind, "step");
        assert.equal(next.decisions.length, 1);
        assert.equal(existsSync(join(workspace, "result.txt")), false);
        assert.equal(calls, 2);
        assert.deepEqual(await (await nativeFetch(`${native}/permission`)).json(), []);
        await store.answer(owner, { id: next.pending.id, execution: next.execution, revision: next.revision, answer: "Write the verified artifact" });
      }
      step = "permission";
      const permission = await waitFor(async () => {
        const r = await nativeFetch(`${native}/permission`);
        const p = await r.json();
        return p[0];
      });
      await nativeFetch(`${native}/permission/${permission.id}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: "once" }),
      });
      await waitFor(() =>
        access(join(workspace, "result.txt")).then(() => true),
      );
      assert.equal(
        await readFile(join(workspace, "result.txt"), "utf8"),
        "verified artifact\n",
      );
      assert.ok(
        captured.some((b) =>
          b.messages.some(
            (m) =>
              m.role === "tool" && String(m.content).includes("userAnswer"),
          ),
        ),
      );
    } catch (e) {
      throw new Error(
        `${e.message}; step=${step} health=${lastHealth}; runtime diagnostic: ${stdout.slice(-1000)} ${diagnostic.slice(-2000)}; model requests: ${captured.length}`,
        { cause: e },
      );
    }
  },
);
