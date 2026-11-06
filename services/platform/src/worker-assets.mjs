import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANAGED_BEGIN = "<!-- scikeel:managed:begin -->";
export const MANAGED_END = "<!-- scikeel:managed:end -->";
const FONT_FILE = "NotoSansCJKsc-Regular-subset.otf";
const FONT_FAMILY = "Noto Sans CJK SC";
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

/** Replace the managed section in place; keep every byte outside the markers. */
export function upsertManagedBlock(existing, block) {
  if (typeof existing !== "string" || typeof block !== "string") throw new Error("invalid managed instruction");
  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END);
  if (begin !== -1 && end > begin) {
    return existing.slice(0, begin + MANAGED_BEGIN.length) + "\n" + block + "\n" + existing.slice(end);
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

/** Provision the worker's writable home and state with the CJK font, the
 *  matplotlib fallback and the managed instruction block. Idempotent. */
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
  const fontPath = join(fontDir, FONT_FILE);
  const memoryPath = join(memoryDir, "MEMORY.md");
  await mkdir(fontDir, { recursive: true, mode: 0o700 });
  await mkdir(mplDir, { recursive: true, mode: 0o700 });
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  await copyFile(join(sourceDir, FONT_FILE), fontPath);
  await writeFile(join(mplDir, "matplotlibrc"), matplotlibrc(), { mode: 0o644 });
  for (const name of await readdir(mplDir)) {
    if (/^fontlist-.*\.json$/.test(name)) await rm(join(mplDir, name), { force: true });
  }
  let existing = "";
  try { existing = await readFile(memoryPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(memoryPath, upsertManagedBlock(existing, managedInstructionBlock(fontPath)), { mode: 0o644 });
}
