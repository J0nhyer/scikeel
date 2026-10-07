import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { load, JSON_SCHEMA } from "js-yaml";

const pack = fileURLToPath(new URL("../../../runtime/skills/core/", import.meta.url));
const helpers = { "domain-check": "domain_check.py", "large-file": "large_file_probe.py", "modal-run": "record_run.py",
  "remote-compute": "record_run.py", "stats-integrity": "stats_integrity_check.py", "traceability-review": "pdf_extract.py" };
const names = ["computer-use", "domain-check", "large-file", "modal-run", "publication-figures", "remote-compute", "research-workflow", "stats-integrity", "traceability-review"];

test("the complete platform pack resolves helpers and styles from the loaded skill directory", async () => {
  const entries = (await readdir(pack, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const dirs = [];
  for (const entry of entries) {
    try { await readFile(join(pack, entry.name, "SKILL.md")); dirs.push(entry.name); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  dirs.sort();
  assert.deepEqual(dirs, [...names].sort());
  for (const name of names) {
    const text = await readFile(join(pack, name, "SKILL.md"), "utf8");
    const info = load(text.match(/^---\n([\s\S]*?)\n---/)[1], { schema: JSON_SCHEMA });
    assert.equal(info.name, name); assert.ok(info.description);
    assert.ok(!text.includes("$XDG_CONFIG_HOME/opencode/skills/"), `${name} still assumes a private copy`);
    if (helpers[name]) {
      assert.ok(text.includes(`<skill-base-directory>/${helpers[name]}`), `${name} does not use the loaded base directory`);
      assert.ok((await readFile(join(pack, name, helpers[name]))).length);
    }
    if (name === "publication-figures") {
      assert.ok(text.includes("<skill-base-directory>/openscience.mplstyle"));
      assert.ok(!text.includes('Path(__file__)'), "the generated script directory is not the skill directory");
      assert.ok((await readFile(join(pack, name, "openscience.mplstyle"))).length);
    }
  }
});

test("loaded-directory helper commands work against local workspace fixtures", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "skill-helper-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "data.csv"), "x,y\n1,2\n3,4\n");
  await writeFile(join(workspace, "analysis.py"), "values = [1, 2, 3]\n");
  for (const [name, input] of [["large-file", "data.csv"], ["domain-check", "analysis.py"]]) {
    const result = spawnSync("python3", [join(pack, name, helpers[name]), input], {
      cwd: workspace, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
    if (name === "large-file") assert.equal(typeof JSON.parse(result.stdout), "object");
    else assert.ok(result.stdout.includes("```review"));
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "skill-migration-")); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), trustedPack = join(root, "old-image-pack");
  const active = join(stateDir, "runtime/xdg-config/opencode/skills"), backup = join(stateDir, "runtime/platform-skills-v1-backup");
  for (const base of [active, trustedPack]) {
    await mkdir(join(base, "publication-figures"), { recursive: true });
    await writeFile(join(base, "publication-figures/SKILL.md"), "original instructions");
    await writeFile(join(base, "publication-figures/openscience.mplstyle"), "original style");
  }
  // The old copy function deploys only directories containing SKILL.md.
  await mkdir(join(trustedPack, "placeholder"));
  await writeFile(join(trustedPack, "placeholder/.gitkeep"), "");
  await writeFile(join(stateDir, "conversation.json"), "keep session data");
  return { stateDir, trustedPack, active, backup };
}
async function migrate(options) {
  const { migratePlatformSkills } = await import("../../../scripts/dev/migrate-platform-skills.mjs");
  return migratePlatformSkills(options);
}

test("migration defaults to dry-run, moves verified copies once, and restores them", async (t) => {
  const f = await fixture(t);
  assert.equal((await migrate(f)).status, "ready");
  assert.equal(await readFile(join(f.active, "publication-figures/SKILL.md"), "utf8"), "original instructions");
  assert.equal((await migrate({ ...f, mode: "apply" })).status, "migrated");
  await assert.rejects(readFile(join(f.active, "publication-figures/SKILL.md")), { code: "ENOENT" });
  assert.equal((await migrate({ ...f, mode: "apply" })).status, "already-migrated");
  assert.equal(await readFile(join(f.backup, "publication-figures/openscience.mplstyle"), "utf8"), "original style");
  assert.equal((await migrate({ ...f, mode: "rollback" })).status, "restored");
  assert.equal((await migrate({ ...f, mode: "rollback" })).status, "already-restored");
  assert.equal(await readFile(join(f.stateDir, "conversation.json"), "utf8"), "keep session data");
});
for (const conflict of ["modified helper", "unknown skill", "symlink", "existing backup"]) {
  test(`migration refuses ${conflict} without moving or deleting private data`, async (t) => {
    const f = await fixture(t);
    if (conflict === "modified helper") await writeFile(join(f.active, "publication-figures/openscience.mplstyle"), "user modification");
    if (conflict === "unknown skill") { await mkdir(join(f.active, "my-skill")); await writeFile(join(f.active, "my-skill/SKILL.md"), "user"); }
    if (conflict === "symlink") await symlink(f.trustedPack, join(f.active, "link"));
    if (conflict === "existing backup") await mkdir(f.backup);
    await assert.rejects(migrate({ ...f, mode: "apply" }), /skill migration conflict/);
    assert.equal(await readFile(join(f.active, "publication-figures/SKILL.md"), "utf8"), "original instructions");
    assert.equal(await readFile(join(f.stateDir, "conversation.json"), "utf8"), "keep session data");
  });
}
test("rollback rejects a modified backup and a recreated active directory", async (t) => {
  const f = await fixture(t); await migrate({ ...f, mode: "apply" });
  await mkdir(f.active);
  await assert.rejects(migrate({ ...f, mode: "rollback" }), /skill migration conflict/);
  await rm(f.active, { recursive: true });
  await writeFile(join(f.backup, "publication-figures/openscience.mplstyle"), "changed");
  await assert.rejects(migrate({ ...f, mode: "rollback" }), /skill migration conflict/);
});
test("a new account has nothing to migrate and invalid modes or root aliases are rejected", async (t) => {
  const f = await fixture(t); await rm(f.active, { recursive: true });
  assert.equal((await migrate(f)).status, "no-copies");
  await assert.rejects(migrate({ ...f, mode: "delete" }), /invalid migration mode/);
  const alias = join(f.stateDir, "alias"); await symlink(f.trustedPack, alias);
  await assert.rejects(migrate({ ...f, trustedPack: alias }), /skill migration conflict/);
});
