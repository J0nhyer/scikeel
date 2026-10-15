import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { imageInputPath, selectVerification } from "../../../scripts/dev/web-release-policy.mjs";
import { validateImageManifest, validateBuildContext } from "../../../scripts/dev/stage-sandbox-image.mjs";
import * as staging from "../../../scripts/dev/stage-sandbox-image.mjs";
import * as measurement from "../../../scripts/dev/prepare-science-image.mjs";
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateInstalledImage} from '../../../scripts/dev/web-release.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const nativeInputs=['runtime/codex-patches/required-effect-guard.patch','runtime/codex-patches/required-effect-guard-tests.patch',
 'runtime/codex-patches/required-effect-guard.lock.json','scripts/dev/build-codex-guard-runtime.mjs'];
const nativeLock=JSON.parse(await readFile(new URL('../../../runtime/codex-patches/required-effect-guard.lock.json',import.meta.url),'utf8'));
async function guardedManifest() {
 const sha='a'.repeat(64),commit='b'.repeat(40);
 const integration={...nativeLock,target:'x86_64-unknown-linux-gnu',binarySha256:sha,source:commit,version:'codex-cli 0.157.1'};
 const sourceInputs=await Promise.all(nativeInputs.map(async path=>({path,sha256:hash(await readFile(new URL('../../../'+path,import.meta.url)))})));
 return {schema:1,name:'science-v1',variant:'probe',architecture:'linux/amd64',rootfsSha256:sha,imageDigest:`sha256:${sha}`,
  python:'3.12.12',uv:'0.11.26',baselineLockSha256:sha,toolLockSha256:sha,uncompressedBytes:1000000,fileCount:100,sourceInputs,
  provenance:{repository:'J0nhyer/scikeel',commit,workflow:'sandbox-image.yml'},
  tools:Object.fromEntries(['osd','opencode','node','uv','python','git','codex'].map(name=>[name,{
   version:name==='opencode'?'1.18.32':name==='uv'?'0.11.26':name==='python'?'3.12.12':name==='codex'?'0.157.1':'1.0.0',sha256:sha,path:`opt/scikeel/tools/bin/${name}`}])) ,
  enabledRuntimes:['opencode','codex'],codexRuntime:{integration,resources:{
   'opt/scikeel/tools/bin/codex-resources/bwrap':nativeLock.bwrapSha256,
   'opt/scikeel/tools/bin/native-integration.json':hash(JSON.stringify(integration)+'\n')}}};
}

for (const path of ["runtime/codex-patches/required-effect-guard.patch",
  "runtime/codex-patches/required-effect-guard-tests.patch", "runtime/codex-patches/required-effect-guard.lock.json",
  "scripts/dev/build-codex-guard-runtime.mjs"]) {
  test(`native authority input ${path} invalidates an earlier image`, () => {
    assert.equal(imageInputPath(path), true);
    assert.equal(selectVerification([path], { known: true }).imageRequired, true);
  });
}

test("the build context admits only the fixed measured native integration resources", () => {
  assert.doesNotThrow(() => validateBuildContext(["tools/bin/codex", "tools/bin/codex-resources/bwrap", "tools/bin/native-integration.json"]));
  for (const path of ["tools/bin/codex-resources/auth.json", "tools/bin/codex-resources/config.toml",
    "tools/bin/codex-resources/arbitrary-helper", "tools/bin/native-integration.json/secret", "tools/bin/codex-resources/../auth.json"])
    assert.throws(() => validateBuildContext([path]), /context/);
});

test("an image cannot advertise managed Codex using an unguarded binary identity alone", () => {
  const sha = "a".repeat(64);
  const manifest = { schema: 1, name: "science-v1", variant: "probe", architecture: "linux/amd64",
    rootfsSha256: sha, imageDigest: `sha256:${sha}`, python: "3.12.12", uv: "0.11.26",
    baselineLockSha256: sha, toolLockSha256: sha, uncompressedBytes: 1000000, fileCount: 100,
    provenance: { repository: "J0nhyer/scikeel", commit: "b".repeat(40), workflow: "sandbox-image.yml" },
    tools: Object.fromEntries(["osd", "opencode", "node", "uv", "python", "git", "codex"].map(name => [name, {
      version: name === "opencode" ? "1.18.32" : name === "uv" ? "0.11.26" : name === "python" ? "3.12.12" : name === "codex" ? "0.157.1" : "1.0.0",
      sha256: sha, path: `opt/scikeel/tools/bin/${name}` }])), enabledRuntimes: ["opencode", "codex"] };
  assert.throws(() => validateImageManifest(manifest), /native|guard|integration|resource/);
});
test('a guarded image binds the binary, compiler/dependency locks, exact patch source and measured resource set',async()=>{
 const value=await guardedManifest();assert.doesNotThrow(()=>validateImageManifest(value));
 for(const patch of [{rustVersion:'9.9.9'},{target:'unmeasured-target'},{binarySha256:'c'.repeat(64)},
  {source:'d'.repeat(40)},{patchSha256:'e'.repeat(64)},{testPatchSha256:'f'.repeat(64)},{upstreamLockSha256:'0'.repeat(64)},
  {workspaceLockSha256:'1'.repeat(64)},{unknown:true}])
  assert.throws(()=>validateImageManifest({...value,codexRuntime:{...value.codexRuntime,integration:{...value.codexRuntime.integration,...patch}}}),/native|guard|integration/);
 for(const resources of [{},{...value.codexRuntime.resources,'opt/scikeel/tools/bin/auth.json':'a'.repeat(64)},
  {...value.codexRuntime.resources,'opt/scikeel/tools/bin/codex-resources/bwrap':'a'.repeat(64)}])
  assert.throws(()=>validateImageManifest({...value,codexRuntime:{...value.codexRuntime,resources}}),/native|guard|resource/);
 for(const sourceInputs of [[],value.sourceInputs.slice(1),[...value.sourceInputs,value.sourceInputs[0]],
  value.sourceInputs.map((item,index)=>index?item:{...item,sha256:'f'.repeat(64)})])
  assert.throws(()=>validateImageManifest({...value,sourceInputs}),/native|guard|source/);
});
test('archive verification measures each native resource and compares embedded integration metadata with the signed manifest',async()=>{
 const value=await guardedManifest();
 assert.equal(typeof staging.validateNativeArchive,'function');
 const listing={toolHashes:{...value.codexRuntime.resources,[value.tools.codex.path]:value.tools.codex.sha256},nativeIntegration:value.codexRuntime.integration};
 assert.doesNotThrow(()=>staging.validateNativeArchive(value,listing));
 for(const changed of [{...listing,nativeIntegration:{...listing.nativeIntegration,binarySha256:'d'.repeat(64)}},
  {...listing,toolHashes:{...listing.toolHashes,'opt/scikeel/tools/bin/codex-resources/bwrap':'e'.repeat(64)}},
  {...listing,entries:[{path:'opt/scikeel/tools/bin/codex-resources/extra-helper',type:'file',size:1}]},
  {...listing,nativeIntegration:null}])assert.throws(()=>staging.validateNativeArchive(value,changed),/native|resource|integration/);
});
test('native tool locks cannot disagree with the final manifest or omit its source inputs',async()=>{
 const value=await guardedManifest();assert.equal(typeof staging.validateImageToolLock,'function');
 const lock={schema:1,tools:value.tools,baselineLockSha256:value.baselineLockSha256,sourceInputs:value.sourceInputs,codexRuntime:value.codexRuntime};
 assert.doesNotThrow(()=>staging.validateImageToolLock(value,lock));
 for(const changed of [{...lock,codexRuntime:undefined},{...lock,sourceInputs:[]},
  {...lock,tools:{codex:lock.tools.codex}},
  {...lock,tools:{...lock.tools,codex:{...lock.tools.codex,sha256:'e'.repeat(64)}}}])
  assert.throws(()=>staging.validateImageToolLock(value,changed),/native|lock|source/);
});
test('the tool lock preserves identical uv bytes when the final image measures its installed canonical path',async()=>{
 const value=await guardedManifest();value.tools.uv.path='usr/local/bin/uv';
 const lock={schema:1,tools:{...value.tools,uv:{...value.tools.uv,path:'opt/scikeel/tools/bin/uv'}},baselineLockSha256:value.baselineLockSha256,
  sourceInputs:value.sourceInputs,codexRuntime:value.codexRuntime};
 assert.doesNotThrow(()=>staging.validateImageToolLock(value,lock));
 assert.throws(()=>staging.validateImageToolLock(value,{...lock,tools:{...lock.tools,uv:{...lock.tools.uv,sha256:'e'.repeat(64)}}}),/lock/);
});
test('real archive inspection and the privileged installer both validate native metadata and resource bytes',async()=>{
 const value=await guardedManifest();
 const result=spawnSync('python3',['-c',`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile,tempfile
root=pathlib.Path.cwd().parents[1]
def module(name):
 spec=importlib.util.spec_from_file_location(name,root/'scripts/dev'/f'{name}.py')
 value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
inspector=module('inspect-sandbox-archive');installer=module('install-sandbox-image')
manifest=json.load(sys.stdin)
assert callable(getattr(installer,'validate_native',None)), 'missing native installer validation'
with tempfile.TemporaryDirectory() as folder:
 path=pathlib.Path(folder)/'native.tar.gz'
 binary=b'synthetic native executable';bwrap=b'synthetic sandbox resource'
 sha=lambda value:hashlib.sha256(value).hexdigest()
 manifest['tools']['codex']['sha256']=sha(binary)
 integration=manifest['codexRuntime']['integration'];integration['binarySha256']=sha(binary);integration['bwrapSha256']=sha(bwrap)
 metadata=json.dumps(integration).encode()
 resources=manifest['codexRuntime']['resources'];resources['opt/scikeel/tools/bin/codex-resources/bwrap']=sha(bwrap)
 resources['opt/scikeel/tools/bin/native-integration.json']=sha(metadata)
 files={'opt/scikeel/tools/bin/codex':binary,'opt/scikeel/tools/bin/codex-resources/bwrap':bwrap,'opt/scikeel/tools/bin/native-integration.json':metadata}
 with tarfile.open(path,'w:gz') as archive:
  for name,data in files.items():
   entry=tarfile.TarInfo(name);entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
 listing=inspector.inspect(path)
 assert listing.get('nativeIntegration')==integration, 'native metadata was not read from actual archive'
 assert all(listing['toolHashes'].get(name)==sha(data) for name,data in files.items()), 'unmeasured native archive bytes'
 lock={'schema':1,'tools':manifest['tools'],'baselineLockSha256':manifest['baselineLockSha256'],'sourceInputs':manifest['sourceInputs'],'codexRuntime':manifest['codexRuntime']}
 installer.validate_native(manifest,listing,lock)
 for target in ['metadata','resource','tool-lock','extra-resource']:
  changed=json.loads(json.dumps(listing));changed_lock=json.loads(json.dumps(lock))
  if target=='metadata':changed['nativeIntegration']['source']='d'*40
  if target=='resource':changed['toolHashes']['opt/scikeel/tools/bin/codex-resources/bwrap']='e'*64
  if target=='tool-lock':changed_lock['codexRuntime']['integration']['binarySha256']='f'*64
  if target=='extra-resource':changed['entries'].append({'path':'opt/scikeel/tools/bin/codex-resources/extra-helper','type':'file','size':1})
  try:installer.validate_native(manifest,changed,changed_lock)
  except ValueError:pass
  else:raise AssertionError('installer accepted altered '+target)
print('native archive and installer checks passed')
`],{input:JSON.stringify(value),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/checks passed/);
});
test('production context measurement requires the complete guarded runtime and refuses partial or substituted bytes',async t=>{
 assert.equal(typeof measurement.measureNativeContext,'function');
 const root=await mkdtemp(join(tmpdir(),'native-image-measurement-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const context=join(root,'context');await mkdir(context);
 assert.equal(await measurement.measureNativeContext(context,{required:false,source:'b'.repeat(40)}),null);
 await assert.rejects(measurement.measureNativeContext(context,{required:true,source:'b'.repeat(40)}),/native|runtime/);
 await mkdir(join(context,'tools/bin/codex-resources'),{recursive:true});
 await writeFile(join(context,'tools/bin/codex'),'unverified runtime');
 await assert.rejects(measurement.measureNativeContext(context,{required:false,source:'b'.repeat(40)}),/native|runtime|ENOENT/);
 const value=await guardedManifest();await writeFile(join(context,'tools/bin/native-integration.json'),JSON.stringify(value.codexRuntime.integration));
 await writeFile(join(context,'tools/bin/codex-resources/bwrap'),'unverified sandbox');
 await assert.rejects(measurement.measureNativeContext(context,{required:true,source:'b'.repeat(40)}),/native|runtime|integration/);
});
test('production CI consumes the successful same-source guarded build instead of shipping an OpenCode-only image',async()=>{
 const {load}=await import('js-yaml');const workflow=load(await readFile(new URL('../../../.github/workflows/sandbox-image.yml',import.meta.url),'utf8'));
 const native=workflow.jobs['native-feasibility'],science=workflow.jobs['science-probe-image'];
 assert.equal(native.if,undefined);assert.equal(science.needs,'native-feasibility');
 const upload=native.steps.find(step=>step.uses==='actions/upload-artifact@v4' && step.with.name==='guarded-codex-${{ github.sha }}');
 assert(upload);assert(upload.with.path.includes('codex-resources/bwrap'));assert.equal(upload.if,undefined);
 const download=science.steps.find(step=>step.uses==='actions/download-artifact@v4');
 assert.equal(download.with.name,upload.with.name);assert.equal(download.with.path,'.deploy/guarded-codex');
 const compose=science.steps.find(step=>step.run?.includes('cp .deploy/guarded-codex/codex '));assert(compose);
 assert(compose.run.includes('native-integration.json'));assert(compose.run.includes('codex-resources/bwrap'));
});
test('release verification remeasures installed native resources and metadata instead of trusting a binary-only ready marker',async()=>{
 const value=await guardedManifest();value.variant='production';
 const repo=fileURLToPath(new URL('../../../',import.meta.url));
 value.runnerFiles=Object.fromEntries(await Promise.all(['runner.mjs','file-rpc.mjs','cli-jobs.mjs','project-environment.py','science-environment.mjs','collaboration.mjs','tool-outcome.mjs']
  .map(async name=>[`opt/scikeel/tools/${name}`,hash(await readFile(join(repo,'runtime/sandbox',name)))])));
 const titleLock=JSON.parse(await readFile(join(repo,'runtime/opencode-patches/session-title.lock.json'),'utf8'));
 const networkLock=JSON.parse(await readFile(join(repo,'runtime/opencode-patches/network.lock.json'),'utf8'));
 value.sessionTitleRuntime={...titleLock,target:'bun-linux-x64',version:titleLock.upstreamVersion,binarySha256:value.tools.opencode.sha256,networkRuntime:networkLock};
 value.baselineLockSha256=hash(await readFile(join(repo,'runtime/sandbox/image/uv.lock')));
 const candidate={selection:{imageRequired:false},source:{root:repo,files:[]},production:{imageDigest:null}};
 const toolLock={schema:1,tools:value.tools,baselineLockSha256:value.baselineLockSha256,sourceInputs:value.sourceInputs,codexRuntime:value.codexRuntime};
 const execute=change=>(_command,args)=>{
  const path=args.at(-1),name=path.split('/').at(-1);
  if(args.includes('cat')) {
   if(name==='image-manifest.json')return JSON.stringify(value);
   if(name==='ready.json')return JSON.stringify({schema:1,imageDigest:value.imageDigest});
   if(name==='native-integration.json')return JSON.stringify(change==='metadata'?{...value.codexRuntime.integration,source:'f'.repeat(40)}:value.codexRuntime.integration);
   if(name==='tool-lock.json')return JSON.stringify(change==='lock'?{...toolLock,sourceInputs:[]}:toolLock);
  }
  if(args.includes('sha256sum')) {
   if(name==='tool-lock.json')return (change==='lock-hash'?'f'.repeat(64):value.toolLockSha256)+'  '+path;
   const inside=path.split('/rootfs/')[1];
   if(change==='resource' && inside==='opt/scikeel/tools/bin/codex-resources/bwrap')return 'f'.repeat(64)+'  '+path;
   const sha=value.codexRuntime.resources[inside]??value.runnerFiles[inside]??Object.values(value.tools).find(tool=>tool.path===inside)?.sha256;
   assert(sha,`Unexpected installed path ${inside}`);return sha+'  '+path;
  }
  if(args.includes('python3'))return path.endsWith('codex-resources')?JSON.stringify(change==='extra-resource'?['bwrap','extra-helper']:['bwrap']):'[]';
  assert.fail('Unexpected image verification operation');
 };
 assert.equal((await validateInstalledImage(candidate,value.imageDigest,{execute:execute(null)})).imageDigest,value.imageDigest);
 for(const change of ['resource','metadata','lock','lock-hash','extra-resource'])
  await assert.rejects(validateInstalledImage(candidate,value.imageDigest,{execute:execute(change)}),/native|resource|integration|source/);
});
test('image installation refuses stale privileged extraction helpers rather than relying on an older installed script',async()=>{
 assert.equal(typeof staging.verifyInstallerInputs,'function');const seen=[];
 const readHash=async path=>{seen.push(path);return hash(await readFile(new URL('../../../scripts/dev/'+path.split('/').at(-1),import.meta.url)));};
 await staging.verifyInstallerInputs({readHash});
 assert.deepEqual(seen,['/usr/local/lib/scikeel/install-sandbox-image.py','/usr/local/lib/scikeel/inspect-sandbox-archive.py']);
 for(const bad of [...seen])await assert.rejects(staging.verifyInstallerInputs({readHash:path=>path===bad?'f'.repeat(64):readHash(path)}),/installer|helper|identity/);
});
