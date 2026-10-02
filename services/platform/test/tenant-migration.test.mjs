import test from "node:test";
import assert from "node:assert/strict";
import { nextMigrationState, TenantMigrations, inventoryTenant, copyColdTenant } from "../../../scripts/dev/migrate-tenant-sandboxes.mjs";
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("copied history rebases owned paths atomically and refuses foreign sessions", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"scikeel-rebase-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const helper=fileURLToPath(new URL("../../../scripts/dev/rebase-tenant-history.py",import.meta.url));
  const result=spawnSync("python3",["-c",`
import importlib.util,sqlite3,sys,pathlib
spec=importlib.util.spec_from_file_location('migration',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=pathlib.Path(sys.argv[2])/'copy.db';c=sqlite3.connect(p)
c.executescript('CREATE TABLE session(directory TEXT,path TEXT);CREATE TABLE project(worktree TEXT);')
old='/old/user_a/workspace';new='/new/user_a/workspace'
c.executemany('INSERT INTO session VALUES (?,?)',[(old,old+'/project'),(old+'/project',None)])
c.execute('INSERT INTO project VALUES (?)',(old,));c.commit();c.close()
r=m.rebase(str(p),old,new);assert r['updated']['session.directory']==2
c=sqlite3.connect(p);assert c.execute('SELECT path FROM session WHERE path IS NOT NULL').fetchone()[0]==new+'/project'
c.execute('INSERT INTO session VALUES (?,NULL)',('/peer/workspace',));c.commit();c.close()
try:m.rebase(str(p),new,'/third/user_a/workspace')
except ValueError:pass
else:raise AssertionError('foreign session accepted')
c=sqlite3.connect(p);assert c.execute('SELECT count(*) FROM session WHERE directory=?',(new,)).fetchone()[0]==1;c.close()
`,helper,root],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
});

test("migration requires each verified checkpoint and never falls back after activation", () => {
  assert.equal(nextMigrationState("copied","verifyFailed"),"blocked");
  assert.throws(()=>nextMigrationState("copied","activate"));
  assert.equal(nextMigrationState("verified","activate"),"managed");
  assert.equal(nextMigrationState("managed","runtimeFailed"),"managedUnavailable");
  assert.throws(()=>nextMigrationState("managedUnavailable","rollbackToHost"));
});
test("migration inventory preserves Git/history identity and reports external links without following them", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"scikeel-inventory-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".git"));await writeFile(join(root,".git","HEAD"),"ref: refs/heads/main\n");
  await writeFile(join(root,"history.sqlite-wal"),"private history");await symlink("/etc/passwd",join(root,"external"));
  const result=await inventoryTenant(root);
  assert.equal(result.files.length,2);assert.equal(result.externalLinks.length,1);
  assert.ok(result.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(!JSON.stringify(result).includes("private history"));
});
test("migration checkpoints persist identity and generation atomically across restarts", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"scikeel-migration-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const filePath=join(root,"migration.json");const context={userId:"a",instanceId:"user-a",generation:1};
  const migrations=new TenantMigrations({filePath});await migrations.init();
  await migrations.register(context);
  for(const event of ["drain","backup","copy","verify","activate"])await migrations.transition(context,event);
  assert.equal(migrations.get(context).state,"managed");
  const restarted=new TenantMigrations({filePath});await restarted.init();assert.equal(restarted.get(context).state,"managed");
  await assert.rejects(restarted.transition({...context,userId:"b"},"runtimeFailed"),/identity/);
  await restarted.transition(context,"runtimeFailed");assert.equal(restarted.get(context).state,"managedUnavailable");
});
test("failed migration retains its recovery checkpoint and stale generations cannot resume", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"scikeel-migration-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const migrations=new TenantMigrations({filePath:join(root,"migration.json")});await migrations.init();
  const context={userId:"a",instanceId:"user-a",generation:1};await migrations.register(context);
  await migrations.transition(context,"drain");await migrations.transition(context,"backup");
  await migrations.transition(context,"copyFailed");assert.equal(migrations.get(context).checkpoint,"backedUp");
  await assert.rejects(migrations.transition({...context,generation:2},"recover"),/identity/);
  await migrations.transition(context,"recover");assert.equal(migrations.get(context).state,"backedUp");
});

test("cold migration preserves bytes and internal links, flattens legacy state and omits administrator credentials",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-cold-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"backup"),destination=join(root,"owned");
  await mkdir(join(source,"workspace",".git"),{recursive:true});
  await mkdir(join(source,"state","com.ai4s.workbench","runtime","xdg-data","opencode"),{recursive:true});
  await mkdir(join(source,"state","com.ai4s.workbench","runtime","xdg-config","opencode"),{recursive:true});
  await writeFile(join(source,"workspace",".git","HEAD"),"ref: refs/heads/main\n");
  await writeFile(join(source,"state","com.ai4s.workbench","runtime","xdg-data","opencode","opencode.db-wal"),"cold history bytes");
  await writeFile(join(source,"state","com.ai4s.workbench","runtime","xdg-config","opencode","opencode.json"),"administrator secret");
  await symlink(".git/HEAD",join(source,"workspace","head-link"));
  await symlink("/etc/passwd",join(source,"workspace","external"));
  const result=await copyColdTenant({source,destination,kind:"worker",assertDrained:async()=>true});
  assert.equal(result.verified,true);assert.equal(result.copiedFiles,2);
  assert.equal(await readFile(join(destination,"state","runtime","xdg-data","opencode","opencode.db-wal"),"utf8"),"cold history bytes");
  assert.equal(await readlink(join(destination,"workspace","head-link")),".git/HEAD");
  await assert.rejects(readFile(join(destination,"workspace","external")));
  await assert.rejects(readFile(join(destination,"state","runtime","xdg-config","opencode","opencode.json")));
  assert.equal(result.omittedCredentials.length,1);assert.equal(result.repairNeeded.length,1);
  assert.ok(!JSON.stringify(result).includes("administrator secret"));
  assert.equal(await readFile(join(source,"workspace",".git","HEAD"),"utf8"),"ref: refs/heads/main\n");
});
test("cold migration refuses live sources, reused destinations and native credentials",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-cold-deny-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"source"),destination=join(root,"destination");await mkdir(join(source,"codex-home"),{recursive:true});
  await writeFile(join(source,"codex-home","auth.json"),"secret");
  await writeFile(join(source,"codex-home","config.toml"),"old unsafe provider");
  await mkdir(join(source,"codex-home","profiles","revision","snapshot"),{recursive:true});
  await writeFile(join(source,"codex-home","profiles","revision","snapshot","auth.json"),"nested administrator credential");
  await writeFile(join(source,"codex-home","profiles","revision","snapshot","config.toml"),"nested provider secret");
  await writeFile(join(source,"sessions.json"),"{\"version\":1}");
  await assert.rejects(copyColdTenant({source,destination,kind:"native",assertDrained:async()=>false}),/drained/);
  const result=await copyColdTenant({source,destination,kind:"native",assertDrained:async()=>true});
  assert.equal(result.omittedCredentials.length,4);assert.equal(result.copiedFiles,1);
  await assert.rejects(copyColdTenant({source,destination,kind:"native",assertDrained:async()=>true}),/destination/);
});
test("private home migration excludes inherited CLI credentials and retains user files",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-home-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"source"),destination=join(root,"destination");
  await mkdir(join(source,".codex"),{recursive:true});await mkdir(join(source,".config/opencode"),{recursive:true});
  await writeFile(join(source,".codex/auth.json"),"credential-canary");await writeFile(join(source,".config/opencode/auth.json"),"credential-canary");
  await writeFile(join(source,"notes.txt"),"owned user bytes");
  const result=await copyColdTenant({source,destination,kind:"home",assertDrained:async()=>true});
  assert.equal(result.omittedCredentials.length,2);assert.equal(result.copiedFiles,1);
  assert.equal(await readFile(join(destination,"notes.txt"),"utf8"),"owned user bytes");
  await assert.rejects(readFile(join(destination,".codex/auth.json")));
});

test("interrupted cold verification preserves the original and refuses symlinked source ancestors",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-cold-interrupt-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"source");await mkdir(source);await writeFile(join(source,"history.db"),"original bytes");
  let checks=0;await assert.rejects(copyColdTenant({source,destination:join(root,"partial"),kind:"native",assertDrained:async()=>++checks===1}),/drained/);
  assert.equal(await readFile(join(source,"history.db"),"utf8"),"original bytes");
  await symlink(source,join(root,"alias"));
  await assert.rejects(copyColdTenant({source:join(root,"alias"),destination:join(root,"unsafe"),kind:"native",assertDrained:async()=>true}),/ancestor/);
});
