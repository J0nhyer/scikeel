// @vitest-environment node
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_COLLABORATION_BROWSER)(
  "Web collaboration restores an unanswered decision, saves only real answers, and fits phone widths",
  async () => {
    const { chromium } = createRequire(import.meta.url)(
      process.env.OSD_PLAYWRIGHT_PATH,
    );
    const source = (name) =>
      import(
        pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href
      );
    const { AuthStore } = await source("auth-store");
    const { PlatformServer } = await source("platform-server");
    const { CollaborationStore } = await source("collaboration");
    const root = await mkdtemp(join(tmpdir(), "scikeel-collaboration-web-"));
    await mkdir(join(root, "workers"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const authStore = new AuthStore({
      filePath: join(root, "auth.json"),
      bootstrapAdmin: { username: "fixture", password: "fixture-password" },
    });
    // A fixed, isolated OpenCode HTTP fixture. Real tool suspension is covered by the pinned-runtime acceptance.
    const token = "a".repeat(64),
      session = {
        id: "owned",
        title: "Research fixture",
        directory: workspace,
        parentID: null,
        time: { created: Date.now(), updated: Date.now() },
      };
    const streams = new Set();
    const runtime = createServer(async (req, res) => {
      const path = new URL(req.url, "http://fixture.invalid").pathname;
      if (path === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        );
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      let body =
        path === "/session/owned"
          ? session
          : (path === "/session" || path === "/experimental/session")
            ? [session]
            : path === "/session/status"
              ? {}
              : path === "/config"
                ? { model: "fixture/model" }
                : path === "/config/providers"
                  ? {
                      providers: [
                        {
                          id: "fixture",
                          name: "Fixture",
                          models: {
                            model: { id: "model", name: "Fixture model" },
                          },
                        },
                      ],
                      default: { fixture: "model" },
                    }
                  : path === "/provider"
                    ? { all: [], connected: ["fixture"] }
                    : path === "/agent"
                      ? [{ name: "build", mode: "primary" }]
                      : path === "/v1/whoami"
                        ? { directory: workspace, mode: "full" }
                        : [];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise((r) => runtime.listen(0, "127.0.0.1", r));
    let userId;
    const worker = {
      id: "fixture",
      userId: null,
      generation: 1,
      status: "running",
      workspaceDir: workspace,
    };
    const manager = {
      rootDir: join(root, "workers"),
      init: async () => {},
      ensureWorker: async () => worker,
      getWorker: () => ({ ...worker, id: `user-${userId}`, userId }),
      getWorkerAccess: () => ({
        url: `http://127.0.0.1:${runtime.address().port}`,
        token,
      }),
      acquireOperation: () => () => {},
      listWorkers: () => [worker],
    };
    const webRoot = process.env.OSD_WEB_CANDIDATE || (
      await readFile(resolve("../../.deploy/attachments-build-path"), "utf8")
    ).trim();
    const platform = new PlatformServer({
      authStore,
      workerManager: manager,
      webRoot,
    });
    const address = await platform.listen();
    const origin = `http://${address.host}:${address.port}`;
    const browser = await chromium.launch({
      executablePath: process.env.OSD_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [1280, 390, 320])
        for (const chinese of [false, true]) for (const selectedMode of ["collaborative", "guided", "delegated"]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
          });
          try {
            const login = await context.request.post(`${origin}/auth/login`, {
              headers: { accept: "application/json" },
              data: { username: "fixture", password: "fixture-password" },
            });
            expect(login.status()).toBe(200);
            userId = (await login.json()).user.id;
            platform.collaboration = new CollaborationStore({
              rootDir: join(root, `${width}-${chinese}-${selectedMode}`),
              research: platform.researchTasks,
            });
            platform.collaborationCapabilities.set(userId, 1);
            const owner = {
              userId,
              sessionId: "owned",
              runtime: "opencode",
              directory: workspace,
              workspaceDir: workspace,
            };
            await platform.collaboration.heartbeat(owner, "fixture-page");
            const selected = selectedMode !== "collaborative" ? await platform.collaboration.setMode(owner, selectedMode, 0) : await platform.collaboration.get(owner);
            await platform.collaboration.begin(owner, selected.revision);
            await platform.collaboration.checkpoint(owner, {
              kind: selectedMode === "guided" ? "step" : "method",
              question: `Which normalization method should be used? File: ${"x".repeat(300)}`,
              suggestedAnswer: "Use the original measurements",
            });
            await context.addInitScript(
              (locale) => localStorage.setItem("ai4s.locale", locale),
              chinese ? "zh-Hans" : "en",
            );
            const page = await context.newPage();
            const errors = [],
              prompts = [];
            page.on("pageerror", (e) => errors.push(e.message));
            page.on("request", (r) => {
              if (
                r.method() === "POST" &&
                /\/session\/[^/]+\/(prompt_async|message)/.test(r.url())
              )
                prompts.push(r.url());
            });
            await page.goto(`${origin}/live/owned`);
            const card = page.getByRole("region", {
              name: selectedMode === "guided" ? (chinese ? "下一步确认" : "Next research step") : (chinese ? "科研决策确认" : "Research decision"),
            });
            await card.waitFor({ state: "visible",timeout:10000 }).catch(async error=>{await page.screenshot({path:resolve("../../.deploy/collaboration-browser-failure.png"),fullPage:true});throw new Error(`${error.message}; page=${(await page.locator("body").innerText()).slice(-5000)}; errors=${JSON.stringify(errors)}`);});
            expect(
              await card
                .getByText("Use the original measurements", { exact: false })
                .count(),
            ).toBe(1);
            expect(prompts).toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const mode = page.getByRole("button", {
              name: selectedMode === "guided" ? (chinese ? "托管程度: 低" : "Autonomy: Low") : selectedMode === "delegated" ? (chinese ? "托管程度: 高" : "Autonomy: High") : (chinese ? "托管程度: 中" : "Autonomy: Medium"),
            });
            await mode.click({timeout:3000}).catch(async error => {
              const diagnostic = resolve("../../.deploy/collaboration-control-failure.png");
              await page.screenshot({path:diagnostic,fullPage:true});
              throw new Error(`${error.message}; width=${width}; locale=${chinese ? "zh-Hans" : "en"}; mode=${selectedMode}; screenshot=${diagnostic}`);
            });
            if (width < 768) {
              expect(
                await page
                  .getByRole("button", {
                    name: chinese ? /^低$/ : /^Low$/,
                  })
                  .isDisabled(),
              ).toBe(false);
              expect(await page.getByRole("button", { name: chinese ? /^高$/ : /^High$/ }).isDisabled()).toBe(false);
              await page
                .getByRole("button", {
                  name: chinese ? "关闭" : "Close",
                })
                .click();
            } else {
              expect(
                await page
                  .getByRole("menuitem", {
                    name: chinese ? "低" : "Low",
                    exact: false,
                  })
                  .getAttribute("data-disabled"),
              ).toBe(null);
              expect(await page.getByRole("menuitem", { name: chinese ? /^高$/ : /^High$/ }).getAttribute("data-disabled")).toBe(null);
              await page.keyboard.press("Escape");
            }
            await page.reload();
            await card.waitFor({ state: "visible" });
            expect(prompts).toEqual([]);
            await card.getByRole("textbox").fill("Use method B");
            await card
              .getByRole("button", {
                name: chinese ? "确认答复" : "Confirm answer",
              })
              .click();
            await expect
              .poll(
                async () =>
                  (await platform.collaboration.get(owner)).decisions.at(-1)
                    ?.answer,
              )
              .toBe("Use method B");
            expect(prompts).toEqual([]);
            if (selectedMode === "guided") {
              // Recovery preserves the existing execution; start again only if it actually settled.
              const current = await platform.collaboration.get(owner);
              if (["paused", "completed"].includes(current.phase)) await platform.collaboration.begin(owner, current.revision);
              await platform.collaboration.checkpoint(owner, { kind: "step", question: "Inspection completed: two missing values. Confirm the next analysis outcome?", suggestedAnswer: "Analyze all observations" });
              await card.getByText("Inspection completed: two missing values. Confirm the next analysis outcome?").waitFor();
              expect((await platform.collaboration.get(owner)).decisions).toHaveLength(1);
              expect((await platform.collaboration.guard(owner)).blocked).toBe(true);
              await card.getByRole("textbox").fill("Run the next analysis");
              await card.getByRole("button", { name: chinese ? "确认答复" : "Confirm answer" }).click();
              await expect.poll(async () => (await platform.collaboration.get(owner)).decisions.length).toBe(2);
              expect(prompts).toEqual([]);
            }
            await mkdir(resolve("../../.deploy/verification"), {
              recursive: true,
            });
            await page.screenshot({
              path: resolve(
                `../../.deploy/verification/collaboration-${selectedMode}-${width}-${chinese ? "zh" : "en"}.png`,
              ),
              fullPage: true,
            });
            expect(errors).toEqual([]);
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
      for (const stream of streams) stream.destroy();
      await platform.close();
      runtime.closeAllConnections();
      await new Promise((r) => runtime.close(r));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
