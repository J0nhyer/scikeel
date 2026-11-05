import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";

const CORE_SKILLS = new Set(["domain-check", "large-file", "publication-figures", "stats-integrity", "traceability-review", "research-workflow"]);
const contains = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
};

async function directories(path) {
  try { return await fs.readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function metadata(path) {
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) return null;
  const text = await fs.readFile(path, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;
  const value = load(frontmatter[1], { schema: JSON_SCHEMA });
  if (!value || typeof value !== "object" || typeof value.description !== "string") return null;
  const name = value.name ?? basename(resolve(path, ".."));
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) return null;
  return { name, description: value.description };
}

// Only trusted, shipped packs become personal skills. User installations remain
// in their workspace; never copy skills or credentials from the host's HOME.
export async function seedSkills(home, resourcesDir) {
  const packs = resourcesDir
    ? ["skills", "skills-office", "skills-core"].map((name) => join(resourcesDir, name))
    : [fileURLToPath(new URL("../../../runtime/skills/core/", import.meta.url))];
  const destination = join(home, ".config", "opencode", "skills");
  const names = [];
  for (const pack of packs) {
    for (const entry of await directories(pack)) {
      if (!entry.isDirectory() || (basename(pack) === "skills-core" || basename(pack) === "core") && !CORE_SKILLS.has(entry.name)) continue;
      const source = join(pack, entry.name);
      const info = await metadata(join(source, "SKILL.md")).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) continue;
      const target = join(destination, entry.name);
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
      names.push(entry.name);
      for (const native of [".claude", ".agents"]) {
        const nativeRoot = join(home, native, "skills");
        await fs.mkdir(nativeRoot, { recursive: true, mode: 0o700 });
        await fs.symlink(target, join(nativeRoot, entry.name), process.platform === "win32" ? "junction" : "dir")
          .catch((error) => { if (error.code !== "EEXIST") throw error; });
      }
    }
  }
  return new Set(names);
}

export async function discoverSkills({ home, runtime, workspaceDir, directory = workspaceDir, bundled = new Set() }) {
  const workspace = await fs.realpath(workspaceDir);
  const current = await fs.realpath(directory);
  if (!contains(workspace, current)) throw Object.assign(new Error("skill directory is outside the user workspace"), { status: 403 });
  const privateHome = await fs.realpath(home);
  const native = runtime === "claude" ? ".claude" : ".agents";
  const sources = [{ path: join(home, native, "skills"), boundary: privateHome, source: "user" }];
  // Native CLIs also discover repository skills in ancestors of the active
  // folder. Stop at the user's workspace so accounts never share discovery.
  const ancestors = [];
  for (let cursor = current; contains(workspace, cursor); cursor = resolve(cursor, "..")) {
    ancestors.unshift(cursor);
    if (cursor === workspace) break;
  }
  for (const folder of ancestors) sources.push({ path: join(folder, native, "skills"), boundary: workspace, source: "project" });
  const skills = new Map();
  for (const { path, boundary, source } of sources) {
    for (const entry of await directories(path)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = join(path, entry.name, "SKILL.md");
      let real;
      try { real = await fs.realpath(file); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!contains(boundary, real)) continue;
      // Invalid user skills do not hide valid skills from the same catalog.
      let info;
      try { info = await metadata(real); }
      catch (error) { if (error.name === "YAMLException") continue; throw error; }
      if (info) skills.set(info.name, { ...info, location: file, source: source === "user" && bundled.has(entry.name) ? "builtin" : source });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
