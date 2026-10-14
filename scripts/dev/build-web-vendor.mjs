// Build heavy libraries sequentially with esbuild. Vite emits these files
// without parsing their graphs again; all steps share the host cgroup limit.
import { build } from "esbuild";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function buildVendor({ root = fileURLToPath(new URL("../..", import.meta.url)), outputDirectory = resolve(root, ".deploy/vendor") } = {}) {
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "apps/desktop/node_modules/pptx-preview/dist/pptx-preview.es.js")],
  outfile: join(outputDirectory, "pptx-preview.mjs"),
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  logLevel: "warning",
});
await build({
  entryPoints: [resolve(root, "apps/desktop/node_modules/monaco-editor/esm/vs/index.js")],
  outfile: join(outputDirectory, "monaco-editor.mjs"),
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  logLevel: "warning",
  loader: { ".ttf": "dataurl" },
});
for (const [name, entry] of [
  ["editor", "editor/editor.worker.js"],
  ["json", "language/json/json.worker.js"],
  ["typescript", "language/typescript/ts.worker.js"],
]) {
  await build({
    entryPoints: [resolve(root, "apps/desktop/node_modules/monaco-editor/esm/vs", entry)],
    outfile: join(outputDirectory, `${name}.worker.js`),
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "iife",
    minify: true,
    logLevel: "warning",
  });
}
for (const [name, entry] of [
  ["openchemlib", "openchemlib/dist/openchemlib.js"],
  ["exceljs", "exceljs/dist/exceljs.min.js"],
  ["docx-preview", "docx-preview/dist/docx-preview.mjs"],
  ["3dmol", "3dmol/build/3Dmol.es6-min.js"],
]) {
  await build({
    entryPoints: [resolve(root, "apps/desktop/node_modules", entry)],
    outfile: join(outputDirectory, `${name}.mjs`),
    bundle: true, platform: "browser", target: "es2020", format: "esm", minify: true, logLevel: "warning",
  });
}

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out-dir')) throw new Error('Usage: build-web-vendor.mjs [--out-dir directory]');
  await buildVendor({ outputDirectory: args.length ? resolve(args[1]) : undefined });
}
