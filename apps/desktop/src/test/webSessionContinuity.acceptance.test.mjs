// @vitest-environment node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_CONTINUITY_BROWSER)("running Web turns survive conversation navigation and reload without interruption", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage = process.env.OSD_WEB_CANDIDATE;
  const html = (await readFile(resolve(stage, "index.html"), "utf8")).replace("<head>", "<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>");
  const now = Date.now();
  const sessions = [
    { id: "ses_live", title: "Running continuity fixture", directory: "/tenant/workspace", time: { created: now, updated: now } },
    { id: "ses_other", title: "Other conversation", directory: "/tenant/workspace", time: { created: now - 1, updated: now - 1 } },
  ];
  const history = [
    { info: { id: "msg_user", sessionID: "ses_live", role: "user", time: { created: now }, model: { providerID: "fixture", modelID: "model" } }, parts: [{ id: "part_user", type: "text", text: "Inspect the fixture" }] },
    { info: { id: "msg_assistant", parentID: "msg_user", sessionID: "ses_live", role: "assistant", time: { created: now + 1 }, providerID: "fixture", modelID: "model", agent: "build" }, parts: [{ id: "part_tool", type: "tool", callID: "call_fixture", tool: "read", state: { status: "running", input: { filePath: "README.md" }, title: "Continuity tool fixture" } }] },
  ];
  let active = true;
  const beats = [];
  const streams = new Set();
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
    if (path.startsWith("/api/collaboration/")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : {};
      if (input.action) beats.push({ sessionId: path.split("/").at(-1), ...input });
      json({ available: true, state: { schema: 1, mode: "collaborative", phase: path.endsWith("ses_live") && active ? "running" : "idle", revision: 1, execution: 1, decisions: [], pending: null } }); return;
    }
    const data = {
      "/v1/whoami": { directory: "/tenant/workspace", mode: "full" },
      "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
      "/api/runtime": { runtime: "opencode", kind: "opencode", available: [{ runtime: "opencode", kind: "opencode", enabled: true }] },
      "/config/providers": { providers: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } }], connected: ["fixture"], default: { fixture: "model" } },
      "/provider": { all: [], connected: ["fixture"] }, "/config": { model: "fixture/model" }, "/global/config": { model: "fixture/model" },
      "/experimental/session": sessions, "/session": sessions, "/session/status": active ? { ses_live: { type: "busy" } } : {},
      "/session/ses_live": sessions[0], "/session/ses_other": sessions[1],
      "/session/ses_live/message": history, "/session/ses_other/message": [],
      "/skill": [], "/agent": [{ name: "build", mode: "primary" }], "/command": [], "/permission": [], "/question": [], "/v1/projects": [], "/v1/fs/list": [],
    };
    json(data[path] ?? (path.startsWith("/api/research/") ? { task: null } : {}));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.addInitScript(() => localStorage.setItem("ai4s.locale", "en"));
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/live/ses_live`);
    await page.getByText("Inspect the fixture", { exact: true }).waitFor({ timeout: 12000 }).catch(async error => { console.log(JSON.stringify({ pageText: (await page.locator("body").innerText()).slice(0, 5000), errors })); throw error; });
    expect(await page.getByText(/Interrupted — this turn did not finish/).count()).toBe(0);
    await expect.poll(() => beats.some(b => b.sessionId === "ses_live" && b.action === "heartbeat" && b.pageId.startsWith("background-"))).toBe(true);
    await page.locator('a[href="/live/ses_other"]').first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/live/ses_other");
    const background = beats.find(b => b.sessionId === "ses_live" && b.pageId.startsWith("background-")).pageId;
    expect(beats.some(b => b.sessionId === "ses_live" && b.pageId === background && b.action === "release")).toBe(false);
    // Cold reload while another conversation is visible must rediscover the
    // silent background run rather than relying on pre-refresh browser memory.
    const beforeReload = beats.length;
    await page.reload();
    await expect.poll(() => beats.slice(beforeReload).some(b => b.sessionId === "ses_live" && b.action === "heartbeat" && b.pageId.startsWith("background-"))).toBe(true);
    await page.locator('a[href="/live/ses_live"]').first().click();
    await page.getByText("Inspect the fixture", { exact: true }).waitFor({ timeout: 12000 }).catch(async error => { console.log(JSON.stringify({ pageText: (await page.locator("body").innerText()).slice(0, 5000), errors })); throw error; });
    expect(await page.getByText(/Interrupted — this turn did not finish/).count()).toBe(0);
    await page.reload();
    await page.getByText("Inspect the fixture", { exact: true }).waitFor({ timeout: 12000 }).catch(async error => { console.log(JSON.stringify({ pageText: (await page.locator("body").innerText()).slice(0, 5000), errors })); throw error; });
    expect(await page.getByText(/Interrupted — this turn did not finish/).count()).toBe(0);
    expect(beats.some(b => b.pageId === background && b.action === "release")).toBe(false);
    if (process.env.OSD_DESKTOP_ONLY_ACCEPTANCE !== "1") await page.setViewportSize({ width: 390, height: 900 });
    await page.reload();
    await page.getByText("Inspect the fixture", { exact: true }).waitFor();
    expect(await page.getByText(/Interrupted — this turn did not finish/).count()).toBe(0);
    // The same frozen history with a confirmed idle worker is a real
    // interruption and must still produce exactly one closing diagnostic.
    active = false;
    await page.reload();
    await page.getByText("Inspect the fixture", { exact: true }).waitFor();
    expect(await page.getByText(/Interrupted — this turn did not finish/).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally { await context.close(); await browser.close(); for (const res of streams) res.destroy(); await new Promise(done => server.close(done)); }
}, 60000);
