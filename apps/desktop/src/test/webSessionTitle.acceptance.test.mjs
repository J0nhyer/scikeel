// @vitest-environment node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_TITLE_BROWSER)("committed Web titles refresh, remain isolated, and survive reload on phone and desktop", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = process.env.OSD_WEB_CANDIDATE;
  const html = (await readFile(resolve(stage, "index.html"), "utf8")).replace("<head>", "<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>");
  const now = Date.now();
  const sessions = ["a", "b"].map((name, index) => ({ id: `ses_${name}`, title: `Default ${name}`, directory: "/tenant/workspace", time: { created: now - index, updated: now - index } }));
  const streams = new Set();
  const renamed = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path.startsWith("/assets/")) {
      const file = resolve(stage, `.${path}`);
      if (!file.startsWith(`${stage}/assets/`)) { json({}, 403); return; }
      try { res.writeHead(200, { "content-type": ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[extname(file)] ?? "application/octet-stream" }); res.end(await readFile(file)); }
      catch { res.end(); }
      return;
    }
    if (path === "/" || path.startsWith("/live")) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
    if (path === "/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); streams.add(res); res.on("close", () => streams.delete(res)); return; }
    const session = sessions.find(value => path === `/session/${value.id}`);
    if (session && req.method === "PATCH") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); session.title = body.title; renamed.push({ id: session.id, title: body.title }); json(session); return;
    }
    if (session) { json(session); return; }
    const data = {
      "/v1/whoami": { directory: "/tenant/workspace", mode: "full" },
      "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
      "/api/runtime": { runtime: "opencode", kind: "opencode", available: [{ runtime: "opencode", kind: "opencode", enabled: true }] },
      "/config/providers": { providers: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } }], connected: ["fixture"], default: { fixture: "model" } },
      "/provider": { all: [], connected: ["fixture"] }, "/config": { model: "fixture/model" }, "/global/config": { model: "fixture/model" },
      "/experimental/session": sessions, "/session": sessions, "/session/status": {},
      "/session/ses_a/message": [], "/session/ses_b/message": [],
      "/skill": [], "/agent": [{ name: "build", mode: "primary" }], "/command": [], "/permission": [], "/question": [], "/v1/projects": [], "/v1/fs/list": [],
    };
    json(data[path] ?? (path.startsWith("/api/research/") ? { task: null } : path.startsWith("/api/collaboration/") ? { available: true, state: { schema: 1, mode: "collaborative", phase: "idle", revision: 1, execution: 0, decisions: [], pending: null } } : {}));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const publish = (id, title) => {
    const session = sessions.find(value => value.id === id); session.title = title;
    for (const res of streams) res.write(`data: ${JSON.stringify({ type: "session.updated", properties: { info: session } })}\n\n`);
  };
  try {
    for (const width of [1280, 390]) {
      sessions[0].title = "Default a"; sessions[1].title = "Default b";
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.addInitScript(() => localStorage.setItem("ai4s.locale", "en"));
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const openRail = async () => {
          const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
          if (await expand.isVisible()) await expand.click();
        };
        await page.goto(`${origin}/live/ses_a`);
        await page.locator("textarea").first().waitFor(); await openRail();
        await page.locator('a[href="/live/ses_a"]').first().waitFor();
        publish("ses_a", `Research A ${width}`);
        await expect.poll(() => page.locator('a[href="/live/ses_a"]').first().innerText()).toContain(`Research A ${width}`);
        expect(await page.locator('a[href="/live/ses_b"]').first().innerText()).toContain("Default b");
        await page.locator('a[href="/live/ses_a"]').first().dblclick();
        const input = page.locator('.sidebar-surface input').first(); await input.waitFor();
        // Committing the same visible string must still reach the runtime.
        await input.press("Enter");
        await expect.poll(() => renamed.some(value => value.id === "ses_a" && value.title === `Research A ${width}`)).toBe(true);
        publish("ses_b", `Research B ${width}`);
        await expect.poll(() => page.locator('a[href="/live/ses_b"]').first().innerText()).toContain(`Research B ${width}`);
        await page.reload(); await page.locator("textarea").first().waitFor(); await openRail();
        await expect.poll(() => page.locator('a[href="/live/ses_a"]').first().innerText()).toContain(`Research A ${width}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); for (const res of streams) res.destroy(); await new Promise(done => server.close(done)); }
}, 90000);
