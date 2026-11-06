import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertManagedBlock, provisionWorkerAssets, matplotlibrc, managedInstructionBlock } from "../src/worker-assets.mjs";

const BEGIN = "<!-- scikeel:managed:begin -->";
const END = "<!-- scikeel:managed:end -->";

test("the managed block replaces in place and preserves user text", () => {
  const existing = "user top\n" + BEGIN + "\nold\n" + END + "\nuser bottom\n";
  const merged = upsertManagedBlock(existing, "new");
  assert.equal(merged, "user top\n" + BEGIN + "\nnew\n" + END + "\nuser bottom\n");
  assert.equal(upsertManagedBlock(merged, "new"), merged);
  assert.equal(upsertManagedBlock("", "new"), BEGIN + "\nnew\n" + END + "\n");
});

test("worker assets are provisioned once and stay idempotent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "scikeel-assets-"));
  const roots = { instances: join(dataDir, "workers/instances"), native: join(dataDir, "cli-runtime/users") };
  const sourceDir = join(dataDir, "fonts"); await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "NotoSansCJKsc-Regular-subset.otf"), "font-bytes");
  const context = { userId: "u1", instanceId: "user-u1", generation: 3 };
  await provisionWorkerAssets({ dataDir, roots, context, sourceDir });
  await provisionWorkerAssets({ dataDir, roots, context, sourceDir });
  const memory = await readFile(join(roots.instances, "user-u1/state/runtime/xdg-config/opencode/MEMORY.md"), "utf8");
  assert.equal(memory.split(BEGIN).length, 2);
  assert.match(memory, /bash has no outbound network/);
  assert.match(await readFile(join(roots.native, "u1/home/.cache/matplotlib/matplotlibrc"), "utf8"), /Noto Sans CJK SC/);
  assert.equal(await readFile(join(roots.native, "u1/home/.local/share/fonts/NotoSansCJKsc-Regular-subset.otf"), "utf8"), "font-bytes");
});

test("provisioning refuses a symlinked matplotlib directory", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "scikeel-assets-"));
  const roots = { instances: join(dataDir, "workers/instances"), native: join(dataDir, "cli-runtime/users") };
  const sourceDir = join(dataDir, "fonts"); await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "NotoSansCJKsc-Regular-subset.otf"), "font-bytes");
  const home = join(roots.native, "u1/home"); await mkdir(home, { recursive: true });
  const victim = join(dataDir, "victim"); await mkdir(victim);
  await symlink(victim, join(home, ".cache"));
  const context = { userId: "u1", instanceId: "user-u1", generation: 3 };
  await assert.rejects(provisionWorkerAssets({ dataDir, roots, context, sourceDir }), /unsafe worker asset path/);
  await assert.rejects(readFile(join(victim, "matplotlib", "matplotlibrc")), /ENOENT/);
});

test("provisioning refuses a symlinked MEMORY.md and preserves its target", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "scikeel-assets-"));
  const roots = { instances: join(dataDir, "workers/instances"), native: join(dataDir, "cli-runtime/users") };
  const sourceDir = join(dataDir, "fonts"); await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "NotoSansCJKsc-Regular-subset.otf"), "font-bytes");
  const stateDir = join(roots.instances, "user-u1/state/runtime/xdg-config/opencode");
  await mkdir(stateDir, { recursive: true });
  const victim = join(dataDir, "victim-memory.txt"); await writeFile(victim, "secret");
  await symlink(victim, join(stateDir, "MEMORY.md"));
  const context = { userId: "u1", instanceId: "user-u1", generation: 3 };
  await assert.rejects(provisionWorkerAssets({ dataDir, roots, context, sourceDir }), /unsafe worker asset path/);
  assert.equal(await readFile(victim, "utf8"), "secret");
});

test("duplicate managed blocks collapse to one", () => {
  const existing = BEGIN + "\nold\n" + END + "\nuser\n" + BEGIN + "\nold2\n" + END + "\n";
  const merged = upsertManagedBlock(existing, "new");
  assert.equal(merged.split(BEGIN).length, 2);
  assert.equal(merged.split(END).length, 2);
  assert.match(merged, /\nnew\n/);
  assert.doesNotMatch(merged, /old2/);
  assert.match(merged, /user/);
});

test("the shipped font family matches the instruction and rc", async () => {
  const font = await readFile(new URL("../../../runtime/fonts/NotoSansCJKsc-Regular-subset.otf", import.meta.url));
  const family = Buffer.from([..."Noto Sans CJK SC"].flatMap((character) => [0, character.charCodeAt(0)]));
  assert(font.includes(family));
  assert.match(matplotlibrc(), /Noto Sans CJK SC/);
  assert.match(managedInstructionBlock("/x"), /Noto Sans CJK SC/);
});
