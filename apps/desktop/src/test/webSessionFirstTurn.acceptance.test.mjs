// @vitest-environment node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { expect, test } from "vitest";

/**
 * Manual first-turn browser acceptance, intentionally NOT registered in the
 * release gate. Run it before a Web release and read
 * docs/WEB_RELEASE_CHECKLIST.md. It reproduces the race where a directory
 * correction arrives while the first answer is streaming: the live answer must
 * survive, and the directory must be followed only after the turn is idle.
 */
test.skipIf(!process.env.OSD_FIRST_TURN_BROWSER)(
  "a first Web turn keeps its live answer and follows a directory update only after idle",
  async () => {
    const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
    const stage = process.env.OSD_WEB_CANDIDATE;
    if (!stage) throw new Error("OSD_WEB_CANDIDATE is required");
    const html = (await readFile(resolve(stage, "index.html"), "utf8"))
      .replace("<head>", "<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>");

    const title = "Compare spike sorting methods";
    const finalText = "Live answer keeps the directory update.";
    const originalDirectory = "/tenant/workspace";
    const correctedDirectory = `${originalDirectory}/corrected`;
    const now = Date.now();

    let sessions = [];
    let createdTitle;
    let createCalls = 0;
    let promptAccepted = false;
    let live = false;
    let historyReads = 0;
    let eventConnections = 0;
    const streams = new Set();

    const reset = () => {
      sessions = [];
      createdTitle = undefined;
      createCalls = 0;
      promptAccepted = false;
      live = false;
      historyReads = 0;
      eventConnections = 0;
      for (const stream of streams) stream.destroy();
      streams.clear();
    };

    const emit = (event) => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const json = (res, value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const history = () => [
      { info: { id: "msg_user", sessionID: "ses_first", role: "user", time: { created: now } },
        parts: [{ id: "part_user", type: "text", text: title }] },
      { info: { id: "msg_assistant", sessionID: "ses_first", role: "assistant", parentID: "msg_user",
        time: { created: now + 1, completed: now + 2 } },
        parts: [{ id: "part_live", type: "text", text: finalText }] },
    ];

    const server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, "http://fixture").pathname;
        if (path.startsWith("/assets/")) {
          const file = resolve(stage, `.${path}`);
          if (!file.startsWith(`${stage}/assets/`)) { json(res, {}, 403); return; }
          try {
            res.writeHead(200, { "content-type": ({
              ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
              ".svg": "image/svg+xml", ".png": "image/png",
            })[extname(file)] ?? "application/octet-stream" });
            res.end(await readFile(file));
          } catch { res.writeHead(404); res.end(); }
          return;
        }
        if (path === "/" || path.startsWith("/live")) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(html);
          return;
        }
        if (path === "/event") {
          eventConnections++;
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          res.write('data: {"type":"server.connected","properties":{}}\n\n');
          streams.add(res);
          res.on("close", () => streams.delete(res));
          return;
        }
        let bytes = "";
        if (req.method !== "GET" && req.method !== "HEAD") {
          for await (const chunk of req) bytes += chunk;
        }
        let body = {};
        try { body = bytes ? JSON.parse(bytes) : {}; } catch { body = {}; }

        if (path === "/session" && req.method === "POST") {
          createCalls++;
          createdTitle = body.title;
          sessions = [{
            id: "ses_first",
            title: body.title ?? "New session",
            directory: originalDirectory,
            time: { created: now, updated: now },
          }];
          json(res, { id: "ses_first" });
          return;
        }
        if (path === "/session/ses_first/prompt_async" && req.method === "POST") {
          live = true;
          promptAccepted = true;
          json(res, {}, 202);
          return;
        }
        if (path === "/session/ses_first/message" && req.method === "GET") {
          if (live) historyReads++;
          json(res, history());
          return;
        }
        if (path === "/session/ses_first/abort" && req.method === "POST") {
          json(res, true);
          return;
        }
        if (path === "/session/ses_first") {
          json(res, sessions[0] ?? { id: "ses_first", title: createdTitle, directory: originalDirectory });
          return;
        }
        if (path === "/session/status") {
          json(res, live ? { ses_first: { type: "busy" } } : {});
          return;
        }
        if (path === "/experimental/session" || path === "/session") {
          json(res, sessions);
          return;
        }
        if (path === "/api/workspace/session-workspaces") {
          // Simulate a legacy platform: the client keeps the account-scoped
          // directory instead of allocating a per-session folder.
          json(res, { error: "unsupported" }, 404);
          return;
        }
        if (path.startsWith("/api/collaboration/")) {
          json(res, { available: true, state: {
            schema: 1, mode: "collaborative", phase: live ? "running" : "idle",
            revision: 1, execution: 0, decisions: [], pending: null,
          } });
          return;
        }
        const data = {
          "/api/workspace/operations": { items: [], resolved: [], nextCursor: null },
          "/api/workspace/projects": [],
          "/v1/whoami": { directory: originalDirectory, mode: "full" },
          "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
          "/api/runtime": {
            runtime: "opencode", policyRevision: 1, kind: "opencode",
            context: { instanceId: "user-fixture", generation: 1 },
            available: [{ runtime: "opencode", kind: "opencode", enabled: true,
              models: ["fixture/model"], defaultModel: "fixture/model", selectedModel: "fixture/model",
              status: "ready" }],
          },
          "/config/providers": {
            providers: [{ id: "fixture", name: "Fixture", models: { model: { id: "model", name: "Fixture model" } } }],
            connected: ["fixture"], default: { fixture: "model" },
          },
          "/provider": { all: [], connected: ["fixture"] },
          "/config": { model: "fixture/model" },
          "/global/config": { model: "fixture/model" },
          "/skill": [], "/agent": [{ name: "build", mode: "primary" }],
          "/command": [], "/permission": [], "/question": [],
          "/v1/projects": [], "/v1/fs/list": [],
        };
        json(res, data[path] ?? (path.startsWith("/api/research/") ? { task: null } : {}));
      } catch {
        res.writeHead(500);
        res.end("{}");
      }
    });

    await new Promise(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      executablePath: process.env.OSD_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of (process.env.OSD_DESKTOP_ONLY_ACCEPTANCE === "1" ? [1280] : [1280, 390])) {
        reset();
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
          await context.addInitScript(() => localStorage.setItem("ai4s.locale", "en"));
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          const openRail = async () => {
            const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
            if (await expand.isVisible().catch(() => false)) await expand.click();
          };
          await page.goto(`${origin}/live`);
          const input = page.locator("textarea").first();
          await input.waitFor();
          await openRail();
          await input.fill(title);
          await input.press("Enter");

          await expect.poll(() => promptAccepted, { timeout: 10000 }).toBe(true);
          expect(createCalls).toBe(1);
          expect(createdTitle).toBe(title);
          await expect.poll(() => page.getByRole("button", { name: "Stop", exact: true }).count())
            .toBe(1);

          await openRail();
          const link = page.locator('a[href="/live/ses_first"]').first();
          await link.waitFor();
          await expect.poll(() => link.innerText()).toContain(title);
          // The excerpt is final; there is no managed title spinner or job.
          expect(await page.getByText("Generating title…", { exact: true }).count()).toBe(0);

          // First live token. The turn is busy now; a directory update must not
          // reconnect or replace this transcript with an older history read.
          emit({ type: "message.part.updated", properties: { part: {
            id: "part_live", sessionID: "ses_first", messageID: "msg_assistant",
            type: "text", text: "Live answer ",
          } } });
          await page.getByText("Live answer", { exact: false }).first().waitFor();
          const readsBefore = historyReads;
          const streamsBefore = eventConnections;

          sessions[0] = { ...sessions[0], directory: correctedDirectory, time: { ...sessions[0].time, updated: Date.now() } };
          emit({ type: "session.updated", properties: { info: sessions[0] } });
          await expect.poll(() => page.getByTitle(new RegExp(correctedDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).count())
            .toBeGreaterThan(0);
          await page.waitForTimeout(400);
          expect(historyReads).toBe(readsBefore);
          expect(eventConnections).toBe(streamsBefore);
          expect(await page.getByText("Live answer", { exact: false }).count()).toBeGreaterThan(0);

          // The final token and idle complete the turn. Only now may openSession
          // follow the corrected directory and hydrate history.
          emit({ type: "message.part.updated", properties: { part: {
            id: "part_live", sessionID: "ses_first", messageID: "msg_assistant",
            type: "text", text: finalText,
          } } });
          await page.getByText(finalText, { exact: true }).first().waitFor();
          live = false;
          emit({ type: "session.idle", properties: { sessionID: "ses_first" } });
          await page.getByText(finalText, { exact: true }).first().waitFor({ timeout: 10000 });
          await expect.poll(() => page.getByTitle(new RegExp(correctedDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).count())
            .toBeGreaterThan(0);
          expect(await page.getByText("Generating title…", { exact: true }).count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      for (const stream of streams) stream.destroy();
      await new Promise(done => server.close(done));
    }
  },
  120000,
);
