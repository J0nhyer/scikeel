import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertManagedBlock, provisionWorkerAssets } from "../src/worker-assets.mjs";

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
