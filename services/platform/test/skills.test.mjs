import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills, seedSkills } from "../src/skills.mjs";

test("ships the research workflow Skill for both managed research runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-research-skill-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    const bundled = await seedSkills(home);
    assert.ok(bundled.has("research-workflow"));
    for (const runtime of ["claude", "codex"]) {
      const list = await discoverSkills({ home, runtime, workspaceDir: workspace, bundled });
      assert.equal(list.find((s) => s.name === "research-workflow").source, "builtin");
      const content = await readFile(list.find((s) => s.name === "research-workflow").location, "utf8");
      assert.match(content, /waiting_input/);
      assert.match(content, /traceability-review/);
      assert.match(content, /Never fabricate/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native skills include curated packs and workspace overrides, and cannot cross account boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-skills-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const other = join(root, "other-account");
    const resources = join(root, "resources");
    const skill = async (path, name, description) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: >-\n  ${description}\n  with multiline metadata\n---\nInstructions\n`);
    };
    await mkdir(home);
    await mkdir(workspace);
    await skill(join(resources, "skills-core", "publication-figures"), "publication-figures", "Bundled figures");
    await skill(join(resources, "skills-core", "computer-use"), "computer-use", "Desktop only");
    await skill(join(resources, "skills-office", "pdf"), "pdf", "Read PDF files");
    const bundled = await seedSkills(home, resources);
    assert.deepEqual([...bundled].sort(), ["pdf", "publication-figures"]);
    for (const runtime of ["claude", "codex"]) {
      const native = runtime === "claude" ? ".claude" : ".agents";
      const nested = join(workspace, "sessions", runtime);
      await mkdir(nested, { recursive: true });
      await skill(join(workspace, native, "skills", "publication-figures"), "publication-figures", "Project figures");
      await skill(join(nested, native, "skills", "local"), "local", "Local skill");
      await skill(join(other, runtime), "private", "Another user's skill");
      await symlink(join(other, runtime), join(nested, native, "skills", "crossed"));
      await mkdir(join(nested, native, "skills", "broken"));
      await writeFile(join(nested, native, "skills", "broken", "SKILL.md"), "---\nname: [invalid\n---\n");
      const listed = await discoverSkills({ home, workspaceDir: workspace, directory: nested, runtime, bundled });
      assert.deepEqual(listed.map((item) => item.name), ["local", "pdf", "publication-figures"]);
      assert.equal(listed.find((item) => item.name === "pdf").source, "builtin");
      assert.equal(listed.find((item) => item.name === "publication-figures").source, "project");
      assert.equal(listed.find((item) => item.name === "local").description, "Local skill with multiline metadata");
      assert.match(await readFile(join(home, native, "skills", "pdf", "SKILL.md"), "utf8"), /Read PDF files/);
      await assert.rejects(discoverSkills({ home, workspaceDir: workspace, directory: other, runtime, bundled }), { status: 403 });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
