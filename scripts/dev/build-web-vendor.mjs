// Build heavy libraries sequentially with esbuild. Vite emits these files
// without parsing their graphs again; all steps share the host cgroup limit.
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
await build({
  entryPoints: [resolve(root, "apps/desktop/node_modules/pptx-preview/dist/pptx-preview.es.js")],
  outfile: resolve(root, ".deploy/vendor/pptx-preview.mjs"),
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "esm",
  minify: true,
  logLevel: "warning",
});
await build({
  entryPoints: [resolve(root, "apps/desktop/node_modules/monaco-editor/esm/vs/index.js")],
  outfile: resolve(root, ".deploy/vendor/monaco-editor.mjs"),
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
    outfile: resolve(root, `.deploy/vendor/${name}.worker.js`),
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
    outfile: resolve(root, `.deploy/vendor/${name}.mjs`),
    bundle: true, platform: "browser", target: "es2020", format: "esm", minify: true, logLevel: "warning",
  });
}
