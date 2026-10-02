import { spawn } from "node:child_process";
import scienceEnvironment from "/opt/scikeel/tools/science-environment.mjs";

// CI-only acceptance driver; never copied into an installed scientific image.
const token = "a".repeat(64);
// An alternate loopback address catches accidental fallback to 127.0.0.1.
const address = "127.0.0.2";
const identity = { instanceId: "sandbox-test-ci", generation: 1 };
const child = spawn("/opt/scikeel/tools/bin/node", ["/opt/scikeel/tools/runner.mjs"], {
  env: { PATH: "/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin", SCIKEEL_BIND_ADDRESS: address },
  detached: true, stdio: ["ignore", "ignore", "ignore"],
});
let spawnFailed = false; child.once("error", () => spawnFailed = true);
async function request(path, body, grant = token) {
  return fetch(`http://${address}:4791${path}`, { method: "POST", headers: {
    authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: JSON.stringify({ ...identity, ...body }), signal: AbortSignal.timeout(15000) });
}
try {
  const deadline = Date.now() + 30000; let ready = false;
  while (Date.now() < deadline && !spawnFailed && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://${address}:4791/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("production runner did not become ready");
  const value = { operation: "write", root: "workspace", path: "scientific-result.txt", text: "reproducible" };
  if ((await request("/files", value, "b".repeat(64))).status !== 403) throw new Error("unauthenticated helper accepted");
  if ((await request("/files", { ...value, generation: 2 })).status !== 403) throw new Error("foreign generation accepted");
  if (!(await request("/files", value)).ok) throw new Error("real managed write failed");
  const read = await request("/files", { operation: "read", root: "workspace", path: value.path });
  if (!read.ok || (await read.json()).text !== value.text) throw new Error("real managed read failed");
  if ((await request("/files", { operation: "read", root: "workspace", path: "../state/private" })).status !== 403)
    throw new Error("workspace escape accepted");
  const profile = { model: "fixture/approved", enabled_providers: ["fixture"], provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "fixture", models: { approved: { name: "approved" } },
    options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: "c".repeat(64) } } },
    permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" } };
  const imageDigest=`sha256:${"d".repeat(64)}`;
  if (!(await request("/profile", { profile,imageDigest })).ok) throw new Error("production gateway profile restart failed");
  const preserved = await request("/files", { operation: "read", root: "workspace", path: value.path });
  if (!preserved.ok || (await preserved.json()).text !== value.text) throw new Error("profile restart lost user files");
  const projectDir="/fixture/workspace/science-project";
  if(!(await request("/files",{operation:"mkdir",root:"workspace",path:"science-project"})).ok)throw new Error("owned science project creation failed");
  const hooks=await scienceEnvironment({directory:projectDir},{imageDigest});const output={env:{}};
  await hooks["shell.env"]({cwd:projectDir},output);
  if(!output.env.PATH.startsWith("/opt/scikeel/science/bin:"))throw new Error("shared science shell environment missing");
  console.log(JSON.stringify({ assignedAddress:address,scienceShellEnvironment:true,productionRunner: true, realGateway: true, realFileHelper: true,
    authentication: true, generationBinding: true, workspaceEscapeDenied: true, profileRestart: true }));
} finally {
  const closed = new Promise((done) => child.once("close", done));
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
    await closed; clearTimeout(timer);
  }
}
