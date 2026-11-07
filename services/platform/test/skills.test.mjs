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

test("ships the literature review and citation reviewer skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-literature-skills-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    const bundled = await seedSkills(home);
    assert.ok(bundled.has("literature-review"));
    assert.ok(bundled.has("citation-reviewer"));
    const lit = await readFile(join(home, ".config/opencode/skills/literature-review/SKILL.md"), "utf8");
    assert.match(lit, /OpenAlex/);
    assert.match(lit, /Crossref/);
    assert.match(lit, /webfetch/);
    assert.match(lit, /references\.csv/);
    assert.match(lit, /search_log\.md/);
    assert.match(lit, /Never invent|never invent/);
    assert.match(lit, /unreachable|staged|do not invent/i);
    // Task 1: Europe PMC and the pre-specified search contract.
    assert.match(lit, /Europe PMC/);
    assert.doesNotMatch(lit, /eutils\.ncbi\.nlm\.nih\.gov/);
    assert.match(lit, /fullTextUrlList/);
    assert.match(lit, /pmcid/);
    assert.match(lit, /full_text_status/);
    assert.match(lit, /venue_tier/);
    assert.match(lit, /search\/raw/);
    assert.match(lit, /papers\//);
    assert.match(lit, /`question`|AskQuestion/);
    // Task 2: open-access full-text acquisition.
    assert.match(lit, /Semantic Scholar/);
    assert.match(lit, /openAccessPdf/);
    assert.match(lit, /savePath/);
    assert.match(lit, /pdf-text/);
    assert.match(lit, /html-text/);
    assert.match(lit, /scanned/);
    assert.match(lit, /unavailable/);
    assert.match(lit, /citation_check\.json/);
    assert.match(lit, /citation_check\.md/);
    const cit = await readFile(join(home, ".config/opencode/skills/citation-reviewer/SKILL.md"), "utf8");
    assert.match(cit, /Crossref/);
    assert.match(cit, /retraction/i);
    assert.match(cit, /check: "citation"|citation/);
    assert.match(cit, /Europe PMC/);
    assert.doesNotMatch(cit, /eutils\.ncbi\.nlm\.nih\.gov/);
    assert.match(cit, /citation_check\.json/);
    assert.match(cit, /citation_check\.md/);
    assert.match(cit, /"usage"/);
    assert.match(cit, /uncited/);
    assert.match(cit, /unknown/);
    assert.match(cit, /supported/);
    assert.match(cit, /partial/);
    assert.match(cit, /unsupported/);
    assert.match(cit, /unverifiable/);
    assert.match(cit, /evidence_path/);
    assert.match(cit, /full-text/);
    assert.match(cit, /abstract-only/);
    for (const runtime of ["claude", "codex"]) {
      const list = await discoverSkills({ home, runtime, workspaceDir: workspace, bundled });
      assert.equal(list.find((skill) => skill.name === "literature-review").source, "builtin");
      assert.equal(list.find((skill) => skill.name === "citation-reviewer").source, "builtin");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ships the research delivery contract with all citation artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-delivery-skill-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    await seedSkills(home);
    const flow = await readFile(join(home, ".config/opencode/skills/research-workflow/SKILL.md"), "utf8");
    for (const artifact of ["review.md", "references.csv", "search_log.md", "citation_check.md", "citation_check.json"]) {
      assert.ok(flow.includes(artifact), `research-workflow must name ${artifact}`);
    }
    assert.match(flow, /prepare/);
    assert.match(flow, /claim support/);
    assert.match(flow, /citation metadata \+ claim support/);
    assert.ok(flow.includes('{"title": "...", "status": "completed"}'), "research-workflow must show the minimal report step");
    assert.match(flow, /`"step"`|"step" is not|invalid status/i);
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
