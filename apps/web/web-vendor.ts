import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

const prefix = "\0osd-web-vendor:";
const specs = [
  { source: "monaco-editor", file: "monaco-editor.mjs", css: "monaco-editor.css" },
  { source: "pptx-preview", file: "pptx-preview.mjs" },
  { source: "3dmol", file: "3dmol.mjs" },
  { source: "openchemlib", file: "openchemlib.mjs" },
  { source: "exceljs", file: "exceljs.mjs", defaultExport: true },
  { source: "docx-preview", file: "docx-preview.mjs" },
  { source: "monaco-editor/editor/editor.worker?worker", file: "editor.worker.js", worker: true },
  { source: "monaco-editor/language/json/json.worker?worker", file: "json.worker.js", worker: true },
  { source: "monaco-editor/language/typescript/ts.worker?worker", file: "typescript.worker.js", worker: true },
] as const;

/** Keep large vendor graphs out of Rollup. Files stay inside the local bundle,
 * with content hashes so a deployed browser never reuses a stale vendor module. */
export function webVendorPlugin(directory: string): Plugin {
  const assets = new Map<string, { name: string; ref: string }>();
  return {
    name: "osd-web-vendor",
    apply: "build",
    enforce: "pre",
    buildStart() {
      assets.clear();
      for (const spec of specs) {
        const source = readFileSync(join(directory, spec.file));
        const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
        const name = `${spec.file.replace(/\.(mjs|js)$/, "")}-${hash}.js`;
        const ref = this.emitFile({ type: "asset", fileName: `assets/${name}`, source });
        assets.set(spec.source, { name, ref });
      }
    },
    resolveId(source) {
      if (specs.some((spec) => spec.source === source)) return prefix + encodeURIComponent(source);
      if (source.startsWith("osd-vendor-external:")) {
        // Vite places its JS chunks in assets/, beside these emitted modules.
        return { id: `./${source.slice("osd-vendor-external:".length)}`, external: true };
      }
    },
    load(id) {
      if (!id.startsWith(prefix)) return;
      const spec = specs.find((item) => item.source === decodeURIComponent(id.slice(prefix.length)))!;
      const asset = assets.get(spec.source)!;
      if ("worker" in spec) {
        return `export default function WorkerWrapper(options) {
          return new Worker(import.meta.ROLLUP_FILE_URL_${asset.ref}, options);
        }`;
      }
      const css = "css" in spec ? `import ${JSON.stringify(join(directory, spec.css))};\n` : "";
      const module = JSON.stringify(`osd-vendor-external:${asset.name}`);
      return css + `export * from ${module};` + ("defaultExport" in spec ? `export { default } from ${module};` : "");
    },
  };
}
