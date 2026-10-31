import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActiveOwnerStore } from "../src/active-owner-store.mjs";

test("owner marker keeps the most recent owners bounded and private", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-owner-store-"));
  try {
    const store = new ActiveOwnerStore({ filePath: join(root, "owners.json"), maxOwners: 2 });
    await store.remember("usr_a", 100);
    await store.remember("usr_b", 200);
    await store.remember("usr_a", 300);
    assert.deepEqual(await store.read(), [
      { userId: "usr_a", since: 300 },
      { userId: "usr_b", since: 200 },
    ]);
    await store.remember("usr_c", 400);
    assert.deepEqual((await store.read()).map((owner) => owner.userId), ["usr_c", "usr_a"]);
    const info = await stat(join(root, "owners.json"));
    assert.equal(info.mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner marker ignores missing and malformed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-owner-store-"));
  try {
    const store = new ActiveOwnerStore({ filePath: join(root, "owners.json"), maxOwners: 1 });
    assert.deepEqual(await store.read(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
