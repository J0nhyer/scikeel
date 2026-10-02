import test from "node:test";
import assert from "node:assert/strict";
import { nextMigrationState, TenantMigrations } from "../../../scripts/dev/migrate-tenant-sandboxes.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("migration requires each verified checkpoint and never falls back after activation", () => {
  assert.equal(nextMigrationState("copied","verifyFailed"),"blocked");
  assert.throws(()=>nextMigrationState("copied","activate"));
  assert.equal(nextMigrationState("verified","activate"),"managed");
  assert.equal(nextMigrationState("managed","runtimeFailed"),"managedUnavailable");
  assert.throws(()=>nextMigrationState("managedUnavailable","rollbackToHost"));
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
