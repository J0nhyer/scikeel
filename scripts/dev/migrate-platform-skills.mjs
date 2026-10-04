// Administrator-only migration for stopped account runtimes. The trusted pack
// must come from the retained pre-upgrade image, not the new source checkout.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const conflict = () => new Error("skill migration conflict: retain existing files and review before promotion");
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function directory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === "/" ||
      !(await lstat(path)).isDirectory() || await realpath(path) !== path) throw conflict();
}
async function inventory(root, prefix = "") {
  const items = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { items.push([path, "directory"]); items.push(...await inventory(root, path)); }
    else if (entry.isFile()) items.push([path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")]);
    else throw conflict();
  }
  return items;
}
async function matches(path, trusted) {
  await directory(path);
  if (JSON.stringify(await inventory(path)) !== JSON.stringify(trusted)) throw conflict();
}
export async function migratePlatformSkills({ stateDir, trustedPack, mode = "dry-run" }) {
  if (!["dry-run", "apply", "rollback"].includes(mode)) throw new Error("invalid migration mode");
  await directory(stateDir); await directory(trustedPack);
  // Match sync_skill_pack: only top-level directories with SKILL.md were copied.
  const trusted = [];
  for (const entry of (await readdir(trustedPack, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw conflict();
    if (!entry.isDirectory() || !await exists(join(trustedPack, entry.name, "SKILL.md"))) continue;
    trusted.push([entry.name, "directory"], ...await inventory(trustedPack, entry.name));
  }
  if (!trusted.some(([path]) => path.endsWith("/SKILL.md"))) throw conflict();
  const runtime = join(stateDir, "runtime");
  const active = join(runtime, "xdg-config/opencode/skills");
  const backup = join(runtime, "platform-skills-v1-backup");
  // Refuse aliases in either destination's existing parents before moving data.
  if (await exists(runtime)) await directory(runtime);
  for (const path of [join(runtime, "xdg-config"), join(runtime, "xdg-config/opencode")]) {
    if (await exists(path)) await directory(path);
  }
  const hasActive = await exists(active), hasBackup = await exists(backup);
  if (hasActive && hasBackup) throw conflict();
  if (hasActive) await matches(active, trusted);
  if (hasBackup) await matches(backup, trusted);
  if (mode === "rollback") {
    if (!hasBackup) return { status: hasActive ? "already-restored" : "no-copies" };
    await directory(join(runtime, "xdg-config/opencode"));
    await rename(backup, active);
    return { status: "restored" };
  }
  if (hasBackup) return { status: "already-migrated" };
  if (!hasActive) return { status: "no-copies" };
  if (mode === "dry-run") return { status: "ready", files: trusted.filter(([, type]) => type !== "directory").length };
  await rename(active, backup);
  return { status: "migrated" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [stateDir, trustedPack, flag] = process.argv.slice(2);
    if (process.argv.length < 4 || process.argv.length > 5 || (flag && !["--apply", "--rollback"].includes(flag)))
      throw new Error("Usage: migrate-platform-skills.mjs ABSOLUTE_STATE_DIR TRUSTED_OLD_PACK [--apply|--rollback]; stop the runtime before modifying files");
    console.log(JSON.stringify(await migratePlatformSkills({ stateDir, trustedPack, mode: flag?.slice(2) ?? "dry-run" })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
