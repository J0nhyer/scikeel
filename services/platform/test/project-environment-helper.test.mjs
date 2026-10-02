import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real private venv transactions preserve hash checks, interpreter paths and rollback", { timeout: 30000 }, () => {
  const result=spawnSync("/usr/bin/python3",[fileURLToPath(new URL("../fixtures/project-environment-test.py",import.meta.url))],{encoding:"utf8",timeout:25000,maxBuffer:65536});
  assert.equal(result.status,0,result.stderr);
  const evidence=JSON.parse(result.stdout);
  for(const value of Object.values(evidence))assert.equal(value,true);
});
