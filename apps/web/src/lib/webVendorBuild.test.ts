// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { build, type InlineConfig } from "vite";
import { webVendorPlugin } from "../../web-vendor";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("ships vendor modules, CSS and classic workers locally without transforming their source again", async () => {
  const root = await mkdtemp(join(tmpdir(), "osd-web-vendor-"));
  fixtures.push(root);
  const vendor = join(root, "vendor");
  await mkdir(vendor);
  await writeFile(join(vendor, "monaco-editor.mjs"), "export const answer = 42;");
  await writeFile(join(vendor, "monaco-editor.css"), ".monaco-editor { color: red; }");
  await writeFile(join(vendor, "pptx-preview.mjs"), "export const init = () => 'slides';");
  for (const name of ["3dmol", "openchemlib", "docx-preview"]) {
    await writeFile(join(vendor, `${name}.mjs`), "export const answer = 42;");
  }
  await writeFile(join(vendor, "exceljs.mjs"), "export default { Workbook: class {} };");
  for (const name of ["editor", "json", "typescript"]) {
    await writeFile(join(vendor, `${name}.worker.js`), "self.onmessage = () => self.postMessage(42);");
  }
  await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, "main.js"), [
    'import { answer } from "monaco-editor";',
    'import Worker from "monaco-editor/language/typescript/ts.worker?worker";',
    'window.answer = answer; window.worker = new Worker();',
    'window.slides = () => import("pptx-preview");',
    'import ExcelJS from "exceljs"; window.workbook = new ExcelJS.Workbook();',
  ].join("\n"));
  const transformed: string[] = [];
  const dist = join(root, "dist");
  const options: InlineConfig = {
    root, configFile: false, logLevel: "silent", publicDir: false,
    plugins: [webVendorPlugin(vendor), { name: "track-transform", transform(_code, id) { transformed.push(id); } }],
    build: { outDir: dist, minify: false },
  };
  await build(options);
  expect(transformed.some((id) => id.startsWith(vendor) && !id.endsWith(".css"))).toBe(false);
  const html = await readFile(join(dist, "index.html"), "utf8");
  const entryPath = join(dist, html.match(/src="\/(assets\/[^"]+\.js)"/)![1]);
  const entry = await readFile(entryPath, "utf8");
  const modules = (await Promise.all((await readdir(join(dist, "assets")))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFile(join(dist, "assets", file), "utf8")))).join("\n");
  for (const name of ["monaco-editor", "pptx-preview", "typescript.worker"]) {
    const match = modules.match(new RegExp(`(?:\\./)?(${name.replace(/\./g, "\\.")}-[a-f0-9]+\\.js)`));
    expect(match, `${name} must resolve to a local emitted asset`).not.toBeNull();
    const file = match![1];
    const content = await readFile(resolve(dirname(entryPath), basename(file)), "utf8");
    expect(content).toContain(name === "pptx-preview" ? "slides" : "42");
  }
  const css = html.match(/href="\/(assets\/[^"]+\.css)"/)![1];
  expect(await readFile(join(dist, css), "utf8")).toContain(".monaco-editor");
  expect(entry).toContain("new Worker");
  expect(entry).not.toContain('type: "module"');
  expect(entry).not.toMatch(/https?:\/\//);
  expect(modules).toMatch(/exceljs-[a-f0-9]+\.js/);

  await writeFile(join(vendor, "monaco-editor.mjs"), "export const answer = 43;");
  await build(options);
  const updatedHtml = await readFile(join(dist, "index.html"), "utf8");
  const updatedEntry = await readFile(join(dist, updatedHtml.match(/src="\/(assets\/[^"]+\.js)"/)![1]), "utf8");
  expect(updatedEntry.match(/monaco-editor-[a-f0-9]+\.js/)![0])
    .not.toBe(entry.match(/monaco-editor-[a-f0-9]+\.js/)![0]);
});
