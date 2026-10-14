import test from "node:test";
import assert from "node:assert/strict";
import {ScienceEnvironmentHooks} from "../../../runtime/sandbox/cli-jobs.mjs";
const manifest={workspaceDir:"/tenant/workspace",home:"/tenant/home"};
const imageDigest=`sha256:${"a".repeat(64)}`;
function fixture(state="valid") {
  const calls=[];
  const inspector={call:async value=>{calls.push(value);return {owned:true,projectDir:"/tenant/workspace/project",imageDigest,
    venvState:state,basePython:"/opt/scikeel/science/bin/python",venvPython:"/tenant/workspace/project/.venv/bin/python"};}};
  return {hooks:new ScienceEnvironmentHooks({manifest,directory:"/tenant/workspace/project",imageDigest,inspector}),calls};
}
test("shell tools use the current project private environment, even from a nested working directory",async()=>{
  const f=fixture();const output={env:{PATH:"/host/bin"}};
  await f.hooks.apply({cwd:"/tenant/workspace/project/results"},output);
  assert.equal(output.env.PATH.split(":")[0],"/tenant/workspace/project/.venv/bin");
  assert.equal(output.env.VIRTUAL_ENV,"/tenant/workspace/project/.venv");
  assert.equal(output.env.PYTHONNOUSERSITE,"1");
  assert.deepEqual(f.calls,[{operation:"inspect",project:"project",imageDigest}]);
  assert.ok(!JSON.stringify(output).includes("API_KEY"));
});
test("projects without overrides use the shared baseline and broken environments never silently fall back",async()=>{
  const f=fixture("absent");const output={env:{VIRTUAL_ENV:"/old/private"}};
  await f.hooks.apply({cwd:"/tenant/workspace/project"},output);
  assert.equal(output.env.PATH.split(":")[0],"/opt/scikeel/science/bin");assert.equal(output.env.VIRTUAL_ENV,"");
  for(const state of ["external","broken"])await assert.rejects(fixture(state).hooks.apply({cwd:"/tenant/workspace/project"},{env:{}}));
  await assert.rejects(f.hooks.apply({cwd:"/peer/workspace"},{env:{}}));
  await assert.rejects(f.hooks.apply({cwd:"/tenant/workspace/project/../peer"},{env:{}}));
});
test("environment inspection cannot redirect shell tools to another project or image",async()=>{
  for(const patch of [{owned:false},{projectDir:"/peer/project"},{imageDigest:`sha256:${"b".repeat(64)}`},{venvPython:"/peer/python"}]){
    const inspector={call:async()=>({owned:true,projectDir:"/tenant/workspace/project",imageDigest,venvState:"valid",
      venvPython:"/tenant/workspace/project/.venv/bin/python",...patch})};
    const hooks=new ScienceEnvironmentHooks({manifest,directory:"/tenant/workspace/project",imageDigest,inspector});
    await assert.rejects(hooks.apply({cwd:"/tenant/workspace/project"},{env:{}}));
  }
});


test("webfetch permission metadata gets a default timeout before approval", async () => {
  const {hooks}=fixture();const args={url:"https://example.invalid",format:"markdown"};
  assert.equal(typeof hooks.beforeTool,"function");
  await hooks.beforeTool({tool:"webfetch"},{args});
  assert.deepEqual(args,{url:"https://example.invalid",format:"markdown",timeout:60});
});
test("webfetch keeps explicit timeouts and unrelated tools keep their arguments", async () => {
  const {hooks}=fixture();const args={url:"https://example.invalid",timeout:10};
  assert.equal(typeof hooks.beforeTool,"function");
  await hooks.beforeTool({tool:"webfetch"},{args});assert.equal(args.timeout,10);
  const shell={command:"echo test"};await hooks.beforeTool({tool:"bash"},{args:shell});assert.deepEqual(shell,{command:"echo test"});
});
