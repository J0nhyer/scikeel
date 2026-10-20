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
  let working = false;
  let aborts = 0;
  const firstMessage = () => ({ info: { id: "msg_first", sessionID: "ses_a", role: "user", time: { created: sessions[0].time.created } }, parts: [{ type: "text", text: "Compare spike sorting methods" }] });
  const lifecycleHistory = () => [firstMessage(), { info: { id: "msg_answer", sessionID: "ses_a", role: "assistant", parentID: "msg_first", time: { created: sessions[0].time.created + 1, ...(working ? {} : { completed: sessions[0].time.created + 2 }) } }, parts: [{ type: "text", text: "Research is progressing independently of title generation." }] }];
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
    if (path === "/" || path.startsWith("/live") || path === "/history") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); return; }
    if (path === "/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); streams.add(res); res.on("close", () => streams.delete(res)); return; }
    if (path === "/session/ses_a/abort" && req.method === "POST") {
      aborts++; working = false; sessions[0].metadata.scikeelSessionTitle.status = "failed";
      for (const stream of streams) {
        stream.write(`data: ${JSON.stringify({ type: "session.updated", properties: { info: sessions[0] } })}\n\n`);
        stream.write('data: {"type":"session.idle","properties":{"sessionID":"ses_a"}}\n\n');
      }
      json({}); return;
    }
    if (path === "/session/ses_a/message/msg_first") { json(firstMessage()); return; }
    const session = sessions.find(value => path === `/session/${value.id}`);
    if (session && req.method === "PATCH") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); session.title = body.title; session.metadata = { ...session.metadata, scikeelSessionTitle: { source: "manual" } }; renamed.push({ id: session.id, title: body.title }); json(session); return;
    }
    if (session) { json(session); return; }
    const data = {
      '/api/workspace/operations': {items:[],resolved:[],nextCursor:null},
      "/v1/whoami": { directory: "/tenant/workspace", mode: "full" },
      "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
      "/api/runtime": { runtime: "opencode", policyRevision: 1, kind: "opencode", context: { instanceId: "user-fixture", generation: 1 }, available: [{ runtime: "opencode", kind: "opencode", enabled: true }] },
      "/config/providers": { providers: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } }], connected: ["fixture"], default: { fixture: "model" } },
      "/provider": { all: [], connected: ["fixture"] }, "/config": { model: "fixture/model" }, "/global/config": { model: "fixture/model" },
      "/experimental/session": sessions, "/session": sessions, "/session/status": working ? { ses_a: { type: "busy" } } : {},
      "/session/ses_a/message": sessions[0].metadata?.scikeelSessionTitle?.firstMessageID ? lifecycleHistory() : [], "/session/ses_b/message": [],
      "/skill": [], "/agent": [{ name: "build", mode: "primary" }], "/command": [], "/permission": [], "/question": [], "/v1/projects": [], "/v1/fs/list": [],
    };
    json(data[path] ?? (path.startsWith("/api/research/") ? { task: null } : path.startsWith("/api/collaboration/") ? { available: true, state: { schema: 1, mode: "collaborative", phase: working ? "running" : "idle", revision: 1, execution: 0, decisions: [], pending: null } } : {}));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const publish = (id, title) => {
    const session = sessions.find(value => value.id === id); session.title = title;
    for (const res of streams) res.write(`data: ${JSON.stringify({ type: "session.updated", properties: { info: session } })}\n\n`);
  };
  try {
    for (const width of (process.env.OSD_DESKTOP_ONLY_ACCEPTANCE === "1" ? [1280] : [1280, 360])) {
      sessions[0].title = "Default a"; sessions[1].title = "Default b"; delete sessions[0].metadata; working = false;
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

        // First-message state is durable: new pages must not depend on an old
        // page's title request, and pending titles must not block research.
        sessions[0].title = "New session - 2026-10-12T00:00:00.000Z";
        sessions[0].time.created = Date.now(); sessions[0].time.updated = Date.now();
        sessions[0].metadata = { scikeelSessionTitle: { version: 1, source: "default", status: "running", firstMessageID: "msg_first" } };
        working = true;
        await page.reload();
        await page.getByText("Research is progressing independently of title generation.", { exact: true }).waitFor();
        await page.getByRole("heading", { name: "Generating title…", exact: true }).waitFor();
        expect(await page.getByText(/New session - 2026/).count()).toBe(0);
        const beforeClose = aborts;
        await page.close();
        const reopened = await context.newPage();
        reopened.on("pageerror", error => errors.push(error.message));
        await reopened.goto(`${origin}/live/ses_a`);
        await reopened.getByRole("heading", { name: "Generating title…", exact: true }).waitFor();
        expect(aborts).toBe(beforeClose);
        const collapse = reopened.getByRole("button", { name: "Collapse sidebar", exact: true });
        const collapseBox = await collapse.boundingBox();
        if (collapseBox && collapseBox.x >= 0 && collapseBox.x < width) await collapse.click();
        await reopened.getByRole("button", { name: "Stop", exact: true }).click();
        await reopened.getByRole("heading", { name: "Compare spike sorting methods", exact: true }).waitFor();
        expect(aborts).toBe(beforeClose + 1);
        if (process.env.OSD_TITLE_SCREENSHOTS) await reopened.screenshot({ path: resolve(process.env.OSD_TITLE_SCREENSHOTS, `title-fallback-${width}.png`) });
        await reopened.reload();
        await reopened.getByRole("heading", { name: "Compare spike sorting methods", exact: true }).waitFor();
        await reopened.getByText("Research is progressing independently of title generation.", { exact: true }).waitFor();

        // A restarted worker may leave a durable running job with an old clock.
        // Reopening must use the excerpt, never reset a 35-second spinner or POST.
        sessions[0].metadata.scikeelSessionTitle.status = "running";
        sessions[0].time.created = Date.now() - 60_000;
        await reopened.reload();
        await reopened.getByRole("heading", { name: "Compare spike sorting methods", exact: true }).waitFor();
        expect(await reopened.getByText("Generating title…", { exact: true }).count()).toBe(0);
        expect(aborts).toBe(beforeClose + 1);

        // The archive must receive late title success after task idle.
        await reopened.goto(`${origin}/history`);
        await reopened.getByRole("button", { name: "Compare spike sorting methods", exact: true }).waitFor();
        sessions[0].metadata.scikeelSessionTitle.source = "automatic";
        sessions[0].metadata.scikeelSessionTitle.status = "completed";
        publish("ses_a", `Recovered summary ${width}`);
        await reopened.getByRole("button", { name: `Recovered summary ${width}`, exact: true }).waitFor();
        await reopened.close();
        const completed = await context.newPage();
        await completed.goto(`${origin}/history`);
        await completed.getByRole("button", { name: `Recovered summary ${width}`, exact: true }).waitFor();
        expect(await completed.getByText(/New session - 2026/).count()).toBe(0);
        if (process.env.OSD_TITLE_SCREENSHOTS) await completed.screenshot({ path: resolve(process.env.OSD_TITLE_SCREENSHOTS, `title-archive-${width}.png`) });
        expect(await completed.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); for (const res of streams) res.destroy(); await new Promise(done => server.close(done)); }
}, 180000);
