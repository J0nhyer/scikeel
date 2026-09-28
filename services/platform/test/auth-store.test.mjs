import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { AuthStore } from "../src/auth-store.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "osd-auth-"));
  roots.push(root);
  return new AuthStore({ filePath: join(root, "auth.json"), ...options });
}

test("bootstraps an administrator and stores hashes instead of credentials", async () => {
  const store = await makeStore({ bootstrapAdmin: { username: "Admin", password: "correct horse battery staple" } });
  await store.init();

  const users = await store.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, "admin");
  assert.equal(users[0].role, "admin");
  assert.equal(users[0].passwordHash, undefined);
  assert.ok(await store.authenticate("ADMIN", "correct horse battery staple"));
  assert.equal(await store.authenticate("admin", "wrong password"), null);

  const raw = await readFile(store.filePath, "utf8");
  assert.doesNotMatch(raw, /correct horse battery staple/);
  assert.match(raw, /scrypt\$/);
});

test("creates sessions, expires them, and disables the account", async () => {
  let timestamp = 1_800_000_000_000;
  const store = await makeStore({
    clock: () => timestamp,
    sessionTtlMs: 100,
    bootstrapAdmin: { username: "admin", password: "admin-password" },
  });
  const admin = await store.authenticate("admin", "admin-password");
  const user = await store.createUser({ username: "student", password: "student-password" });
  const session = await store.createSession(user.id);
  assert.ok(session?.token);
  assert.equal((await store.getUserBySession(session.token)).id, user.id);

  timestamp += 101;
  assert.equal(await store.getUserBySession(session.token), null);

  const freshSession = await store.createSession(user.id);
  assert.ok(freshSession);
  assert.deepEqual(await store.disableUser(user.id), { ...user, disabled: true, updatedAt: new Date(timestamp).toISOString() });
  assert.equal(await store.getUserBySession(freshSession.token), null);
  await assert.rejects(store.disableUser(admin.id), /last active administrator/);
});

test("serializes concurrent account creation and rejects duplicate usernames", async () => {
  const store = await makeStore({ bootstrapAdmin: { username: "admin", password: "admin-password" } });
  const results = await Promise.allSettled([
    store.createUser({ username: "student", password: "student-password" }),
    store.createUser({ username: "student", password: "student-password" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected")[0].reason.code, "duplicate_username");
  assert.equal((await store.listUsers()).length, 2);
});

test("changes a password and revokes the account's existing sessions", async () => {
  const store = await makeStore({ bootstrapAdmin: { username: "admin", password: "admin-password" } });
  const admin = await store.authenticate("admin", "admin-password");
  const session = await store.createSession(admin.id);

  const updated = await store.setPassword(admin.id, "admin123");
  assert.equal(updated.id, admin.id);
  assert.equal(await store.authenticate("admin", "admin-password"), null);
  assert.equal((await store.authenticate("admin", "admin123")).id, admin.id);
  assert.equal(await store.getUserBySession(session.token), null);
});
