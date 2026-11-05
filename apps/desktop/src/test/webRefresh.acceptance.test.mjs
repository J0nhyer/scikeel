// @vitest-environment node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_REFRESH_ACCEPTANCE)("Web refresh keeps locale and managed workspace labels while loading sessions alongside SSE", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = process.env.OSD_WEB_CANDIDATE || resolve("dist");
  const html = (await readFile(resolve(stage, "index.html"), "utf8")).replace("<head>", "<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>");
  const reads = [];
  const timers = new Set();
  let failSessions = false;
  const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const session = { id: "ses_fixture", title: "Fixture conversation", directory: "/tenant/workspace", time: { created: 1, updated: 1 } };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname.startsWith("/assets/")) {
      const path = resolve(stage, `.${url.pathname}`);
      if (!path.startsWith(`${stage}/assets/`)) { res.writeHead(403); res.end(); return; }
      try {
        const bytes = await readFile(path);
        res.writeHead(200, { "content-type": ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[extname(path)] || "application/octet-stream" }); res.end(bytes);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    if (url.pathname === "/" || url.pathname.startsWith("/live") || url.pathname === "/files") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
    if (url.pathname === "/event") {
      reads.push({ kind: "event-request", at: Date.now() });
      const timer = setTimeout(() => {
        timers.delete(timer);
        reads.push({ kind: "event-open", at: Date.now() });
        res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"server.connected","properties":{}}\n\n');
      }, 700);
      timers.add(timer); return;
    }
    if (url.pathname === "/experimental/session" || url.pathname === "/session") {
      reads.push({ kind: "sessions", at: Date.now() });
      json(res, failSessions ? { error: "fixture unavailable" } : [session], failSessions ? 503 : 200); return;
    }
    const data = {
      "/v1/whoami": { directory: "/tenant/workspace", mode: "full" },
      "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
      "/api/runtime": { runtime: "opencode", kind: "opencode", available: [{ runtime: "opencode", kind: "opencode", enabled: true }] },
      "/config/providers": { providers: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } }], connected: ["fixture"], default: { fixture: "model" } },
      "/global/config": { model: "fixture/model" }, "/skill": [{ name: "fixture-skill" }],
      "/agent": [], "/command": [], "/permission": [], "/question": [], "/session/status": {}, "/v1/projects": [],
      "/session/ses_fixture": session, "/session/ses_fixture/message": [], "/v1/fs/list": [],
    };
    json(res, data[url.pathname] ?? {});
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        for (const language of [null, "en", "zh-Hans"]) {
          if (language) await page.evaluate(value => localStorage.setItem("ai4s.locale", value), language);
          const start = reads.length;
          const streamOpened = page.waitForResponse(response => new URL(response.url()).pathname === "/event");
          await page.goto(`${origin}/live/ses_fixture`);
          const label = language === "en" ? "Workspace" : "工作区";
          console.log(JSON.stringify({ width, language, phase: "open" }));
          await page.getByRole("button", { name: label, exact: true }).waitFor();
          expect(await page.locator("html").getAttribute("lang")).toBe(language ?? "zh-Hans");
          await page.waitForFunction(() => !document.body.textContent.includes("OpenCode ·"));
          await page.getByRole("button", { name: label, exact: true }).click();
          await page.screenshot({ path: resolve(`../../.deploy/verification/refresh-${width}-${language ?? "default"}.png`) });
          await page.getByText(label, { exact: true }).last().waitFor();
          await streamOpened;
          const batch = reads.slice(start);
          expect(batch.find(entry => entry.kind === "sessions").at).toBeLessThan(batch.find(entry => entry.kind === "event-open").at);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.reload();
          await page.getByRole("button", { name: label, exact: true }).waitFor();
          expect(await page.locator("html").getAttribute("lang")).toBe(language ?? "zh-Hans");
          expect(await page.getByText("workspace", { exact: true }).count()).toBe(0);
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    failSessions = true;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/live`);
      await page.getByRole("button", { name: "连接", exact: true }).waitFor({ timeout: 20_000 });
      expect(await page.getByText(/OpenCode ·/).count()).toBe(0);
      expect(await page.getByText(/工作区 ·/).count()).toBe(1);
    } finally { await context.close(); }
  } finally {
    await browser.close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}, 90_000);
