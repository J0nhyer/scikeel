import assert from "node:assert/strict";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {CliRuntimeManager} from "../src/cli-runtime.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "history-concurrency-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const runtime = join(root, "runtime"), workspace = join(root, "workspace"), userId = "usr_history";
  const manager = new CliRuntimeManager({rootDir: runtime, sandboxJobs: {}, profileResolver: {}});
  const paths = manager.userPaths(userId);
  for (const directory of [runtime, join(runtime, "metadata"), paths.root, workspace]) {
    await fs.mkdir(directory, {mode: 0o700});
  }
  const session = {id: "ses_cli_0000000000000000", userId, runtime: "codex", directory: workspace,
    title: "Owned conversation", history: [], createdAt: 1, updatedAt: 1};
  const state = {userId, paths, sessions: new Map([[session.id, session]])};
  await manager.persistUser(state);
  const read = () => manager.readHistoricalSessions({userId, workspaceDir: workspace});
  assert.equal((await read()).length, 1);
  return {manager, state, session, paths, runtime, read};
}

test("historical reads retain an available owned snapshot during atomic saves", async t => {
  const {manager, state, session, read} = await fixture(t);
  const results = await Promise.allSettled([
    (async () => {
      for (let index = 0; index < 100; index++) {
        session.updatedAt = index + 2;
        await manager.persistUser(state);
      }
    })(),
    (async () => {
      for (let index = 0; index < 100; index++) {
        const rows = await read();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, session.id);
      }
    })(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

test("historical reads permit unrelated private directory creation", async t => {
  const {runtime, read} = await fixture(t);
  const lstat = fs.lstat;
  let created = false;
  t.mock.method(fs, "lstat", async (path, options) => {
    const entry = await lstat(path, options);
    if (path === runtime && !created) {
      created = true;
      await fs.mkdir(join(runtime, "another-private-user"), {mode: 0o700});
    }
    return entry;
  });
  assert.equal((await read()).length, 1);
  assert.equal(created, true);
});

for (const change of ["replacement", "permissions"]) {
  test(`historical reads reject a private directory ${change} change`, async t => {
    const {paths, read} = await fixture(t);
    const lstat = fs.lstat;
    let changed = false;
    t.mock.method(fs, "lstat", async (path, options) => {
      const entry = await lstat(path, options);
      if (path === paths.root && !changed) {
        changed = true;
        if (change === "replacement") {
          await fs.rename(paths.root, paths.root + "-previous");
          await fs.mkdir(paths.root, {mode: 0o700});
          await fs.copyFile(join(paths.root + "-previous", "sessions.json"), join(paths.root, "sessions.json"));
          await fs.chmod(join(paths.root, "sessions.json"), 0o600);
        } else {
          await fs.chmod(paths.root, 0o755);
        }
      }
      return entry;
    });
    await assert.rejects(read(), {code: "historical_source_unavailable"});
    assert.equal(changed, true);
  });
}
