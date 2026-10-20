import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServer } from "../../../runtime/sandbox/cli-jobs.mjs";

for (const exited of [false, true]) test(`the production native adapter cleans surviving children when its app-server ${exited ? "already exited" : "is still running"}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-production-native-stop-"));
  const ready = join(root, "child-ready"), marker = join(root, "late-effect");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),800);`;
  const source = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const frame=JSON.parse(line);if(!frame.id)return;
    const result=frame.method==='thread/start'?{thread:{id:'fixture-thread'}}:frame.method==='turn/start'?{turn:{id:'fixture-turn'}}:{};
    process.stdout.write(JSON.stringify({id:frame.id,result})+'\\n');
    if(frame.method==='turn/start'){require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});${exited ? "setTimeout(()=>process.exit(0),100);" : ""}}
  });`;
  let child, stopped = 0;
  // This real process-group regression uses a synthetic server, not installed image resources.
  const runtime = new CodexAppServer({ verifyRuntime:async()=>{}, emit: async () => {}, onStopped: () => { stopped++; }, requestTimeoutMs: 2000,
    spawnImpl: (_binary, _args, options) => {
      assert.equal(options.detached, true);
      child = spawn(process.execPath, ["-e", source], { ...options, cwd: root });
      return child;
    } });
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await runtime.close(); await rm(root, { recursive: true, force: true });
  });
  const started = await runtime.start({ privateHome: "/fixture/home", projectDir: "/fixture/project",
    environment: { kind: "base", python: "/opt/scikeel/science/bin/python" }, brokers: { modelToken: "a".repeat(64) },
    model: "gpt-6.1-sol", text: "Synthetic cleanup test" });
  assert.deepEqual(started, { nativeSessionId: "fixture-thread", turnId: "fixture-turn" });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { if (await readFile(ready, "utf8") === "ready" && (!exited || child.exitCode !== null)) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(ready, "utf8"), "ready");
  assert.equal(child.exitCode, exited ? 0 : null);
  await runtime.close();
  assert.equal(stopped, 1);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await assert.rejects(access(marker), { code: "ENOENT" }, "A completed cleanup must prevent the already-running child's delayed write");
});
