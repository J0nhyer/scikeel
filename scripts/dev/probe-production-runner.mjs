import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, readdir, unlink, symlink, stat } from "node:fs/promises";

if (process.argv[2] === "--native-capabilities") {
  const { runNativeProtocolProbe } = await import("/fixture/repo/services/platform/fixtures/native-protocol.mjs");
  await runNativeProtocolProbe();
  process.exit(0);
}

const { default: scienceEnvironment } = await import("/opt/scikeel/tools/science-environment.mjs");

// CI-only acceptance driver; never copied into an installed scientific image.
const token = "a".repeat(64);
// An alternate loopback address catches accidental fallback to 127.0.0.1.
const address = "127.0.0.2";
const identity = { instanceId: "sandbox-test-ci", generation: 1 };
// OpenCode checks plugin dependencies in the background on a fresh home.
// The offline fixture must refuse that optional fetch promptly, as production's
// egress broker does, so local bundled plugins can finish initialization.
await writeFile("/fixture/home/.npmrc", "registry=http://127.0.0.1:1\nfetch-retries=0\nfetch-timeout=1000\n");
const child = spawn("/opt/scikeel/tools/bin/node", ["/opt/scikeel/tools/runner.mjs"], {
  env: { PATH: "/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin", SCIKEEL_BIND_ADDRESS: address, SCIKEEL_CI_DIAGNOSTICS: "1" },
  detached: true, stdio: ["ignore", "ignore", "inherit"],
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
      const response = await fetch(`http://${address}:4791/health/live`, { signal: AbortSignal.timeout(500) });
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
  const managed=async body=>{
    const response=await request('/files',{root:'workspace',...body});
    if(!response.ok){
      if(body.operation==='snapshot'){
        console.error('Snapshot fixture ownership:',{processUid:process.getuid(),workspaceUid:(await stat('/fixture/workspace')).uid});
        const diagnostic=spawn('git',['status','--porcelain'],{cwd:'/fixture/workspace',stdio:['ignore','ignore','inherit']});await new Promise(done=>diagnostic.once('close',done));
      }
      throw new Error('real management helper failed: '+body.operation);
    }
    return response.json();
  };
  const original=await managed({operation:'readText',path:value.path});
  await managed({operation:'saveTextIfRevision',path:value.path,expectedRevision:original.revision,text:value.text});
  if((await request('/files',{operation:'saveTextIfRevision',root:'workspace',path:value.path,expectedRevision:'f'.repeat(64),text:'must not overwrite'})).status!==409)throw new Error('stale revision accepted');
  await managed({operation:'mkdirAll',path:'.scikeel/workspace-management/uploads/probe'});
  await managed({operation:'createText',path:'.scikeel/workspace-management/uploads/probe/payload',text:'private staging'});
  await managed({operation:'createText',path:'.env.fixture',text:'fixture secret'});
  if(!(await managed({operation:'snapshot',path:''})).committed)throw new Error('real local snapshot missing');
  const refs=execFileSync('git',['for-each-ref','--format=%(refname)','refs/openscience/snapshots/'],{cwd:'/fixture/workspace',encoding:'utf8',timeout:5000}).trim().split('\n');
  if(refs.length!==1 || !refs[0].startsWith('refs/openscience/snapshots/'))throw new Error('snapshot ref missing');
  const committed=execFileSync('git',['show',refs[0]+':'+value.path],{cwd:'/fixture/workspace',encoding:'utf8',timeout:5000});
  if(committed!==value.text)throw new Error('snapshot lost workspace content');
  const indexed=execFileSync('git',['ls-tree','-r','--name-only',refs[0]],{cwd:'/fixture/workspace',encoding:'utf8',timeout:5000});
  if(indexed.includes('.scikeel/workspace-management/') || indexed.includes('.env.fixture'))throw new Error('snapshot contains private payload');
  await symlink(value.path,'/fixture/workspace/management-link');
  if((await request('/files',{operation:'stat',root:'workspace',path:'management-link'})).ok)throw new Error('management followed a linked alias');
  await unlink('/fixture/workspace/management-link');
  if ((await request("/files", { operation: "read", root: "workspace", path: "../state/private" })).status !== 403)
    throw new Error("workspace escape accepted");
  const profile = { model: "fixture/approved", enabled_providers: ["fixture"], provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "fixture", whitelist: ["approved"], models: { approved: { name: "approved" } },
    options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: "c".repeat(64) } } },
    permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" } };
  const imageDigest=`sha256:${"d".repeat(64)}`;
  if (!(await request("/profile", { profile,imageDigest })).ok) throw new Error("production gateway profile restart failed");
  const preserved = await request("/files", { operation: "read", root: "workspace", path: value.path });
  if (!preserved.ok || (await preserved.json()).text !== value.text) throw new Error("profile restart lost user files");
  const gateway = async (path) => fetch(`http://${address}:4790${path}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  for (const root of ["workspace", "base"]) {
    const response = await gateway(`/v1/fs/list?root=${root}&path=`);
    if (!response.ok || !(await response.json()).some((entry) => entry.name === value.path))
      throw new Error(`managed ${root} inventory failed`);
    const preview = await gateway(`/v1/fs/read?root=${root}&path=${value.path}`);
    if (!preview.ok || await preview.text() !== value.text) throw new Error("managed gateway preview failed");
  }
  // /v1/health reports the gateway process before its OpenCode sidecar is
  // accepting requests. Wait for a real workspace-scoped session response.
  const runtimeDeadline = Date.now() + 25000;
  let runtimeReady = false;
  while (Date.now() < runtimeDeadline) {
    try {
      const response = await gateway("/session?directory=%2Ffixture%2Fworkspace");
      if (response.ok && Array.isArray(await response.json())) { runtimeReady = true; break; }
      await response.body?.cancel();
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!runtimeReady) {
    for (const path of ["/fixture/state/debug.log", "/fixture/state/runtime/xdg-data/opencode/log/opencode.log"]) {
      try { console.error((await readFile(path, "utf8")).slice(-6000)); } catch {}
    }
    throw new Error("managed OpenCode runtime did not become ready");
  }
  const skillsResponse = await gateway("/skill?directory=%2Ffixture%2Fworkspace");
  if (!skillsResponse.ok) throw new Error(`managed skill discovery failed (${skillsResponse.status}): ${(await skillsResponse.text()).slice(0, 500)}`);
  const skills = await skillsResponse.json();
  const shared = "/opt/scikeel/tools/resources/skills-core";
  const platformNames = ["computer-use", "domain-check", "large-file", "modal-run", "publication-figures",
    "remote-compute", "research-workflow", "stats-integrity", "traceability-review"];
  for (const name of platformNames) {
    const entries = skills.filter((skill) => skill.name === name);
    if (entries.length !== 1 || entries[0].location !== `${shared}/${name}/SKILL.md`)
      throw new Error(`shared skill discovery failed: ${name}`);
  }
  const privateSkills = "/fixture/state/runtime/xdg-config/opencode/skills";
  try {
    if ((await readdir(privateSkills)).length) throw new Error("managed startup recreated private platform skills");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const helpers = { "domain-check": "domain_check.py", "large-file": "large_file_probe.py", "modal-run": "record_run.py",
    "remote-compute": "record_run.py", "stats-integrity": "stats_integrity_check.py", "traceability-review": "pdf_extract.py" };
  for (const [name, helper] of Object.entries(helpers)) {
    const text = await readFile(`${shared}/${name}/SKILL.md`, "utf8");
    if (!text.includes(`<skill-base-directory>/${helper}`) || !(await readFile(`${shared}/${name}/${helper}`)).length)
      throw new Error(`shared skill helper missing: ${name}`);
  }
  await writeFile("/fixture/workspace/helper-data.csv", "x,y\n1,2\n3,4\n");
  JSON.parse(execFileSync("/opt/scikeel/science/bin/python", [`${shared}/large-file/large_file_probe.py`, "helper-data.csv"],
    { cwd: "/fixture/workspace", encoding: "utf8", timeout: 10000 }));
  const writeProbe = `${shared}/.acceptance-write-probe`;
  let sharedWriteDenied = false;
  try { await writeFile(writeProbe, "must not be writable", { flag: "wx" }); }
  catch (error) { if (!["EROFS", "EACCES"].includes(error.code)) throw error; sharedWriteDenied = true; }
  if (!sharedWriteDenied) { await unlink(writeProbe); throw new Error("shared skills are writable"); }
  const figures = skills.find((skill) => skill.name === "publication-figures");
  if (!figures) throw new Error("publication figures skill missing");
  const skillDirectory = figures.location.slice(0, figures.location.lastIndexOf("/"));
  const resources = execFileSync("rg", ["--no-config", "--files", "--hidden", "--glob=!**/SKILL.md", "."],
    { cwd: skillDirectory, encoding: "utf8", timeout: 5000 });
  if (!resources.split("\n").some((file) => file.endsWith("openscience.mplstyle"))) throw new Error("skill resource enumeration failed");
  const configurationResponse = await gateway("/config?directory=%2Ffixture%2Fworkspace");
  if (!configurationResponse.ok) throw new Error("managed configuration unavailable");
  const configuration = await configurationResponse.json();
  if (JSON.stringify(configuration.skills?.paths) !== JSON.stringify([shared])) throw new Error("shared skill path configuration missing");
  const directoryRules = configuration.permission.external_directory;
  if (directoryRules["*"] !== "deny" || directoryRules[`${skillDirectory.slice(0, skillDirectory.lastIndexOf("/"))}/*`] !== "allow" ||
      configuration.permission.bash !== "ask" || configuration.permission.edit !== "ask") throw new Error("managed skill policy regression");
  const projects = await gateway("/v1/projects");
  if (!projects.ok || !Array.isArray(await projects.json())) throw new Error("managed project inventory failed");
  const runs = await gateway("/v1/runs");
  if (!runs.ok || !Array.isArray(await runs.json())) throw new Error("managed run inventory failed");
  const escapedPreview = await gateway("/v1/fs/read?root=base&path=../state/private");
  if (escapedPreview.ok) throw new Error("managed gateway workspace escape accepted");
  const projectDir="/fixture/workspace/science-project";
  if(!(await request("/files",{operation:"mkdir",root:"workspace",path:"science-project"})).ok)throw new Error("owned science project creation failed");
  const hooks=await scienceEnvironment({directory:projectDir},{imageDigest});const output={env:{}};
  await hooks["shell.env"]({cwd:projectDir},output);
  if(!output.env.PATH.startsWith("/opt/scikeel/science/bin:"))throw new Error("shared science shell environment missing");
  // Use the installed runner, immutable requirements and production adapter.
  // No provider is reachable in this network=none container; only synthetic
  // credentials are used and a real native acceptance must precede cleanup.
  const nativeStart=await request('/jobs',{operation:'start',sessionId:'ci-native-startup',project:'.',model:'gpt-6.1-sol',
    text:'Offline startup contract. Do not execute tools.',identityRevision:'ci-native-profile',
    turnIdentity:{...identity,userId:'ci-user',conversationId:'ci-native-startup',execution:1,requestId:'ci-native-startup',policyRevision:1,runtime:'codex'},
    nativeProfile:{model:'gpt-6.1-sol',modelToken:'b'.repeat(64),modelUrl:'http://172.31.240.1:4792/v1'}});
  if(!nativeStart.ok)throw new Error(`installed native startup rejected (${nativeStart.status})`);
  const native=await nativeStart.json();
  if(!/^[a-f0-9]{64}$/.test(native.jobId??'')||!native.nativeSessionId||!native.turnId)throw new Error('installed native acceptance missing');
  const nativeStop=await request('/jobs',{operation:'abort',jobId:native.jobId});
  if(!nativeStop.ok||(await nativeStop.json()).stopped!==true)throw new Error('installed native cleanup unverified');
  const nativeInventory=await request('/jobs',{operation:'inspect'});
  if(!nativeInventory.ok||(await nativeInventory.json()).busy!==false)throw new Error('installed native startup left an active job');
  console.log(JSON.stringify({ assignedAddress:address,scienceShellEnvironment:true,productionRunner: true, realGateway: true, realFileHelper: true,
    installedNativeAcceptance:true,installedNativeCleanup:true,
    workspaceInventory: true, artifactPreview: true, skillResources: true, sharedSkillLocations: true, sharedWriteDenied, privateSkillCopies: false, localSkillHelper: true, offlineRipgrep: true, projectInventory: true, runInventory: true,
    authentication: true, generationBinding: true, workspaceEscapeDenied: true, profileRestart: true, conditionalSave: true, privateSnapshotExcluded: true, noFollowManagement: true }));
} finally {
  const closed = new Promise((done) => child.once("close", done));
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
    await closed; clearTimeout(timer);
  }
}
