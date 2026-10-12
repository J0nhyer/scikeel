// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_PROJECTS_ACCEPTANCE && !process.env.OSD_PROJECTS_LIVE_ACCEPTANCE)("Web projects create scoped conversations, preserve cancellation and reopen after reload", async () => {
  if (process.env.OSD_PROJECTS_LIVE_ACCEPTANCE) {
    const { verifyLiveProjects } = await import("./webProjects.live.mjs");
    return verifyLiveProjects();
  }
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { CliRuntimeManager } = await module("cli-runtime");
  const { PlatformServer } = await module("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-projects-"));
  const home = join(root, "codex"); await mkdir(home);
  await writeFile(join(home, "config.toml"), 'model = "fixture-model"\n');
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  await authStore.createUser({ username: "other", password: "other-password" });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome: home, codexCommand: process.execPath, codexArgs: [resolve("../../services/platform/fixtures/fake-cli.mjs"), "codex"] });
  const platform = new PlatformServer({ authStore, workerManager, cliRuntime, webRoot: process.env.OSD_PROJECTS_WEB_ROOT });
  const address = await platform.listen(); const origin = `http://${address.host}:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  try {
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
        expect(login.status()).toBe(200); const { user } = await login.json(); await cliRuntime.setUserRuntime(user.id, "codex");
        const page = await context.newPage(); const errors = []; let creations = 0; let turns = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/projects") creations++;
          if (request.method() === "POST" && /\/prompt_async$/.test(new URL(request.url()).pathname)) turns++;
        });
        await page.goto(`${origin}/projects`);
        const openSidebar = async () => {
          const expand = page.getByRole("button", { name: /Expand sidebar/ }).first();
          if (await expand.isVisible()) await expand.click();
        };
        const create = async (name) => {
          await openSidebar();
          await page.getByRole("button", { name: "New project", exact: true }).first().click();
          const dialog = page.getByRole("dialog", { name: "Name project" });
          await dialog.getByRole("textbox").fill(name);
          const faultCheck = width === 1280 && name.startsWith("A ");
          if (faultCheck) {
            await page.route("**/v1/projects", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture create failure" }) }), { times: 1 });
            await dialog.getByRole("button", { name: "Save", exact: true }).click();
            await dialog.getByRole("alert").waitFor();
            expect(await dialog.getByRole("textbox").inputValue()).toBe(name);
            await page.route("**/v1/whoami", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
          }
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          if (faultCheck) {
            const retry = dialog.getByRole("button", { name: "Retry opening", exact: true });
            await expect.poll(() => retry.isEnabled(), { timeout: 15_000 }).toBe(true);
            expect(await dialog.getByRole("textbox").inputValue()).toBe(name);
            await page.unroute("**/v1/whoami");
            await retry.click();
          }
          await dialog.waitFor({ state: "hidden" });
          await page.locator("textarea").waitFor();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/live");
        };
        const send = async (text) => {
          await page.locator("textarea").fill(text);
          const button = page.getByRole("button", { name: "Send", exact: true });
          await expect.poll(() => button.isEnabled()).toBe(true);
          await button.click();
          try { await page.getByText(new RegExp(`Codex\\[fixture-model\\]:[\\s\\S]*${text}`)).first().waitFor(); }
          catch (error) {
            await mkdir(resolve("../../.deploy/verification/web-projects"), { recursive: true });
            await page.screenshot({ path: resolve(`../../.deploy/verification/web-projects/failed-${width}.png`), fullPage: true });
            console.error("Fixture page:", await page.locator("body").innerText());
            throw error;
          }
          await expect.poll(() => new URL(page.url()).pathname.startsWith("/live/ses_")).toBe(true);
          return new URL(page.url()).pathname.split("/").pop();
        };
        await create(`A ${width}`); const aId = await send(`Scope A ${width}`);
        await create(`B ${width}`); const bId = await send(`Scope B ${width}`);
        expect(aId).not.toBe(bId); expect(creations).toBe(width === 1280 ? 3 : 2); expect(turns).toBe(2);
        const projects = await (await context.request.get(`${origin}/v1/projects`)).json();
        const a = projects.find((item) => item.name === `A ${width}`);
        const b = projects.find((item) => item.name === `B ${width}`);
        const state = await cliRuntime.ensureUser(user.id);
        expect(state.sessions.get(aId).directory).toBe(a.path);
        expect(state.sessions.get(bId).directory).toBe(b.path);
        const file = await context.request.get(`${origin}/v1/fs/read?dir=${encodeURIComponent(a.path)}&path=scope.txt`);
        expect(file.status()).toBe(200); expect(await file.text()).toBe(a.id);
        if (width === 1280) {
          const other = await browser.newContext();
          try {
            const otherLogin = await other.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "other", password: "other-password" } });
            expect(otherLogin.status()).toBe(200);
            const otherUser = (await otherLogin.json()).user;
            await cliRuntime.setUserRuntime(otherUser.id, "codex");
            expect([403, 404]).toContain((await other.request.get(`${origin}/session/${aId}?directory=${encodeURIComponent(a.path)}`)).status());
            expect((await other.request.get(`${origin}/v1/fs/read?dir=${encodeURIComponent(a.path)}&path=scope.txt`)).status()).toBe(403);
          } finally { await other.close(); }
        }
        // Unsent text and an in-flight upload must survive a cancelled replacement.
        let releaseUpload;
        if (width === 1280) {
          const hold = new Promise(resolve => { releaseUpload = resolve; });
          await page.route("**/api/attachments/upload?*", async route => { await hold; await route.continue(); }, { times: 1 });
          await page.locator('input[type="file"]').first().setInputFiles({ name: "pending.csv", mimeType: "text/csv", buffer: Buffer.from("value\n1\n") });
          await page.getByRole("button", { name: "Remove pending.csv", exact: true }).waitFor();
        }
        await page.locator("textarea").fill("Keep this unsent message");
        if (releaseUpload) expect(await page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(false);
        await openSidebar();
        await page.getByRole("button", { name: "Projects", exact: true }).click();
        await page.getByRole("heading", { name: "Projects", exact: true }).locator("..").getByRole("button", { name: `New session in A ${width}`, exact: true }).click();
        const confirmation = page.getByRole("alertdialog");
        await confirmation.waitFor();
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.goBack();
        expect(await page.locator("textarea").inputValue()).toBe("Keep this unsent message");
        if (releaseUpload) {
          expect(await page.getByRole("button", { name: "Remove pending.csv", exact: true }).count()).toBe(1);
          const uploaded = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/attachments/upload");
          releaseUpload(); expect((await uploaded).status()).toBe(201);
          await expect.poll(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
          await openSidebar();
          await page.getByRole("button", { name: "Projects", exact: true }).click();
          await page.getByRole("heading", { name: "Projects", exact: true }).locator("..").getByRole("button", { name: `New session in A ${width}`, exact: true }).click();
          await page.getByRole("alertdialog").getByRole("button", { name: "Discard and continue", exact: true }).click();
          await page.locator("textarea").waitFor();
          expect(await page.locator("textarea").inputValue()).toBe("");
          expect(await page.getByRole("button", { name: "Remove pending.csv", exact: true }).count()).toBe(0);
          expect(turns).toBe(2);
          await page.goto(`${origin}/live/${bId}`);
        }
        // Browser reload deliberately guarantees saved sessions, not unsent File objects.
        await page.getByText(new RegExp(`Codex\\[fixture-model\\]:[\\s\\S]*Scope B ${width}`)).first().waitFor();
        const beforeReload = turns; await page.reload();
        await page.getByText(new RegExp(`Codex\\[fixture-model\\]:[\\s\\S]*Scope B ${width}`)).first().waitFor();
        expect(turns).toBe(beforeReload);
        const reads = [];
        page.on("requestfailed", request => reads.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
        page.on("response", response => { const url = new URL(response.url()); if (["/v1/whoami", "/api/runtime", "/event", "/session"].includes(url.pathname)) reads.push({ path: url.pathname, directory: url.searchParams.get("directory"), status: response.status() }); });
        await page.goto(`${origin}/live/${aId}`);
        try { await page.getByText(new RegExp(`Codex\\[fixture-model\\]:[\\s\\S]*Scope A ${width}`)).first().waitFor(); }
        catch (error) {
          console.error("Fixture reads:", reads);
          console.error("Reopened fixture page:", page.url(), await page.locator("body").innerText());
          console.error("Fixture session list:", await (await context.request.get(`${origin}/session`)).json());
          throw error;
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await mkdir(resolve("../../.deploy/verification/web-projects"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/web-projects/candidate-${width}.png`), fullPage: true });
      } finally { await context.close(); }
    }
  } finally {
    await browser.close(); await platform.close(); await cliRuntime.close(); await workerManager.close(); await authStore.close();
    await rm(root, { recursive: true, force: true });
  }
}, 480_000);
