import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_BEGIN = "<!-- scikeel:managed:begin -->";
export const MANAGED_END = "<!-- scikeel:managed:end -->";
const FONT_FILE = "NotoSansCJKsc-Regular-subset.otf";
const FONT_FAMILY = "Noto Sans CJK SC";
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const unsafe = () => Object.assign(new Error("unsafe worker asset path"), { code: "unsafe_worker_asset" });

function stripManaged(text) {
  let out = text;
  for (;;) {
    const begin = out.indexOf(MANAGED_BEGIN);
    if (begin === -1) return out;
    const end = out.indexOf(MANAGED_END, begin + MANAGED_BEGIN.length);
    if (end === -1) return out;
    out = out.slice(0, begin) + out.slice(end + MANAGED_END.length);
  }
}

/** Replace the managed section in place; keep every byte outside the markers. */
export function upsertManagedBlock(existing, block) {
  if (typeof existing !== "string" || typeof block !== "string") throw new Error("invalid managed instruction");
  const begin = existing.indexOf(MANAGED_BEGIN);
  if (begin !== -1) {
    const end = existing.indexOf(MANAGED_END, begin + MANAGED_BEGIN.length);
    if (end !== -1) {
      return existing.slice(0, begin + MANAGED_BEGIN.length) + "\n" + block + "\n" + MANAGED_END +
        stripManaged(existing.slice(end + MANAGED_END.length));
    }
  }
  return existing + (existing && !existing.endsWith("\n") ? "\n" : "") +
    MANAGED_BEGIN + "\n" + block + "\n" + MANAGED_END + "\n";
}

export function managedInstructionBlock(fontPath) {
  if (typeof fontPath !== "string" || !fontPath.startsWith("/")) throw new Error("invalid font path");
  return [
    "## Sandbox limits (SciKeel managed)",
    "",
    "- The sandbox bash has no outbound network. `curl`, `wget`, `pip`, `npm` and raw sockets fail with 403. Do not retry them.",
    "- Use `webfetch` / `websearch` for network access. Package installation is the workbench environment feature.",
    `- A CJK font is available at \`${fontPath}\` (family \`${FONT_FAMILY}\`). If matplotlib reports missing glyphs, call \`font_manager.fontManager.addfont('${fontPath}')\` and include \`${FONT_FAMILY}\` in \`font.sans-serif\`.`,
    "- After applying the publication style, re-add the family because the style sets `font.sans-serif`.",
    "- Run a figure layout check at most twice. If it still fails, simplify the figure or document the limitation; do not repeat the full analysis.",
  ].join("\n");
}

export function matplotlibrc(fontFamily = FONT_FAMILY) {
  return `font.family: sans-serif\nfont.sans-serif: ${fontFamily}, Inter, Helvetica Neue, Arial, sans-serif\naxes.unicode_minus: False\n`;
}

async function ensureDirectory(path) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    metadata = await lstat(path);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafe();
}

async function ensurePath(base, target) {
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || rel.startsWith(sep)) throw unsafe();
  await ensureDirectory(base);
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    await ensureDirectory(current);
  }
}

async function safeWrite(path, data, mode) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(data);
    await handle.sync().catch(() => {});
  } finally { await handle?.close(); }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

async function safeRead(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    if (error.code === "ELOOP") throw unsafe();
    throw error;
  } finally { await handle?.close(); }
}

/** Provision the worker's writable home and state with the CJK font, the
 *  matplotlib fallback and the managed instruction block. Idempotent, and it
 *  never follows a link planted by the tenant. */
export async function provisionWorkerAssets({
  dataDir,
  roots,
  context,
  sourceDir = fileURLToPath(new URL("../../../runtime/fonts/", import.meta.url)),
}) {
  if (!identifier(context?.userId) || !identifier(context?.instanceId) ||
      (dataDir !== undefined && (typeof dataDir !== "string" || !dataDir.startsWith("/")))) throw new Error("invalid worker asset context");
  const instances = roots?.instances ?? join(dataDir, "workers/instances");
  const native = roots?.native ?? join(dataDir, "cli-runtime/users");
  const home = join(native, context.userId, "home");
  const fontDir = join(home, ".local/share/fonts");
  const mplDir = join(home, ".cache/matplotlib");
  const memoryDir = join(instances, context.instanceId, "state/runtime/xdg-config/opencode");
  await ensurePath(native, home);
  await ensurePath(home, fontDir);
  await ensurePath(home, mplDir);
  await ensurePath(instances, memoryDir);
  const fontPath = join(fontDir, FONT_FILE);
  await safeWrite(fontPath, await readFile(join(sourceDir, FONT_FILE)), 0o644);
  await safeWrite(join(mplDir, "matplotlibrc"), matplotlibrc(), 0o644);
  for (const name of await readdir(mplDir)) {
    if (!/^fontlist-.*\.json$/.test(name)) continue;
    const path = join(mplDir, name);
    if ((await lstat(path)).isDirectory()) continue;
    await rm(path, { force: true });
  }
  const memoryPath = join(memoryDir, "MEMORY.md");
  const existing = await safeRead(memoryPath);
  await safeWrite(memoryPath, upsertManagedBlock(existing, managedInstructionBlock(fontPath)), 0o644);
}
