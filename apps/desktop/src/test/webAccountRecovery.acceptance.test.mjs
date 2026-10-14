// @vitest-environment node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(process.env.OSD_ACCOUNT_RECOVERY_ACCEPTANCE !== "1")("account logout stays usable through failed workspace preparation at desktop and phone widths", async () => {
  if (!process.env.OSD_WEB_CANDIDATE || !process.env.OSD_PLAYWRIGHT_PATH || !process.env.OSD_CHROMIUM_PATH) throw new Error("Candidate browser prerequisites are missing");
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = name => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { PlatformServer } = await module("platform-server");
  const { TenantPolicy } = await module("tenant-policy");
  const root = await mkdtemp(join(tmpdir(), "scikeel-account-access-"));
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  let workerCalls = 0;
  workerManager.ensureWorker = async () => { workerCalls++; throw new Error("Unavailable fixture workspace"); };
  const platform = new PlatformServer({ authStore, workerManager, tenantPolicy: new TenantPolicy(), webRoot: process.env.OSD_WEB_CANDIDATE });
  let browser;
  const report = [];
  try {
    const address = await platform.listen(); const origin = `http://${address.host}:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const second = await browser.newContext();
    const login = context => context.request.post(origin + "/auth/login", { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
    expect((await login(second)).status()).toBe(200);
    for (const width of [1280, 390, 320]) for (const locale of width === 1280 ? ["en", "zh-Hans"] : ["zh-Hans"]) for (const surface of ["known", "unknown", "preparation", "recovery"]) {
      const labels = locale === "en" ? { signOut: "Sign out", retry: "Retry", restart: "Restart workspace", retryConnection: "Retry connection", cancel: "Cancel", confirm: "Confirm restart", expand: "Expand sidebar", account: "fixture account", settings: "Settings", failed: "Could not sign out. Please retry.", impact: "all devices" } :
        { signOut: "退出登录", retry: "重试", restart: "重启工作区", retryConnection: "重试连接", cancel: "取消", confirm: "确认重启", expand: "展开侧边栏", account: "fixture 的账号", settings: "设置", failed: "无法退出登录，请重试。", impact: "所有设备" };
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        expect((await login(context)).status()).toBe(200);
        await context.addInitScript(({ preparing, locale }) => {
          localStorage.setItem("ai4s.locale", locale);
          if (preparing) sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale, startedAt: Date.now() }));
        }, { preparing: surface === "preparation" || surface === "recovery", locale });
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let workspaceRequests = 0; let logoutRequests = 0;
        const recoveryReport = { context: { instanceId: "user-fixture", generation: 1 }, state: "unresponsive", activity: "unknown", canRestart: true, retryAfterMs: 0 };
        let restarts = 0;
        await page.route("**/api/workspace/status", route => route.fulfill({ status: surface === "preparation" ? 503 : 200, contentType: "application/json", body: surface === "preparation" ? "{}" : JSON.stringify(recoveryReport) }));
        await page.route("**/api/workspace/recover", async route => {
          const body = route.request().postDataJSON();
          expect(body).toEqual({ action: "restart", instanceId: "user-fixture", generation: 1, confirmed: true });
          restarts++;
          return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Workspace has changed", code: "stale_workspace_context", stage: "recovery", context: recoveryReport.context, action: "retry", retryable: true, retryAfterMs: 0 }) });
        });
        await page.route("**/v1/whoami", route => {
          workspaceRequests++;
          if (surface === "preparation") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ directory: "/fixture/workspace", mode: "full" }) });
          return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Unavailable workspace" }) });
        });
        if (surface === "preparation") await page.route("**/api/runtime", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
        if (surface === "unknown") await page.route("**/api/me", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
        await page.route("**/auth/logout", route => ++logoutRequests === 1
          ? route.fulfill({ status: 502, contentType: "application/json", body: "{}" }) : route.continue());
        await page.goto(origin + "/live");
        if (surface === "preparation" || surface === "recovery") {
          const earlySignOut = page.getByRole("button", { name: labels.signOut, exact: true });
          await earlySignOut.waitFor(); expect(await earlySignOut.isEnabled()).toBe(true);
          if (surface === "preparation") {
            await page.getByRole("button", { name: labels.retry, exact: true }).waitFor();
            expect(await page.locator("#root").evaluate(element => element.inert)).toBe(true);
            expect(await page.locator("#scikeel-login-preparation input:not([type=hidden])").count()).toBe(2);
            expect(await page.locator("#scikeel-login-preparation input").evaluateAll(elements => elements.every(element => element.disabled && !element.value))).toBe(true);
          } else {
          await page.getByRole("button", { name: labels.restart, exact: true }).waitFor();
          expect(await page.locator("#root").evaluate(element => element.inert)).toBe(false);
          expect(await page.locator("#scikeel-login-preparation").count()).toBe(0);
          await page.getByRole("button", { name: labels.restart, exact: true }).click();
          expect(restarts).toBe(0);
          const dialog = page.getByRole("dialog"); await dialog.waitFor();
          expect(await dialog.innerText()).toContain(labels.impact);
          const dialogBox = await dialog.boundingBox();
          expect(dialogBox.x).toBeGreaterThanOrEqual(0); expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
          const screenshots = resolve("../../.deploy/verification"); await mkdir(screenshots, { recursive: true });
          await page.screenshot({ path: join(screenshots, `account-confirm-${locale}-${width}.png`), fullPage: true });
          await dialog.getByRole("button", { name: labels.cancel, exact: true }).click();
          expect(restarts).toBe(0);
          await page.getByRole("button", { name: labels.restart, exact: true }).click();
          await page.getByRole("button", { name: labels.confirm, exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
          await page.getByRole("button", { name: labels.retryConnection, exact: true }).waitFor();
          expect(restarts).toBe(1);
          }
        } else {
          if (width < 768) await page.getByRole("button", { name: labels.expand, exact: true }).click();
          if (surface === "known") await page.getByRole("button", { name: labels.account, exact: true }).click();
          else expect(await page.getByRole("menuitem", { name: labels.settings, exact: true }).count()).toBe(0);
        }
        const signOut = surface === "known" ? page.getByRole("menuitem", { name: labels.signOut, exact: true }) :
          surface === "unknown" ? page.locator("aside").getByRole("button", { name: labels.signOut, exact: true }) : page.getByRole("button", { name: labels.signOut, exact: true });
        await signOut.waitFor();
        expect(await signOut.isEnabled()).toBe(true);
        await signOut.click();
        await page.getByText(labels.failed, { exact: true }).waitFor();
        expect((await context.request.get(origin + "/api/me", { headers: { accept: "application/json" } })).status()).toBe(200);
        const requestsAfterSuspension = workspaceRequests;
        await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
        await page.waitForTimeout(500);
        expect(workspaceRequests).toBe(requestsAfterSuspension);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const box = await signOut.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(40);
        const screenshots = resolve("../../.deploy/verification"); await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, `account-${surface}-${locale}-${width}.png`), fullPage: true });
        await Promise.all([page.waitForURL(origin + "/login"), signOut.click()]);
        expect(logoutRequests).toBe(2);
        expect((await context.request.get(origin + "/api/me", { headers: { accept: "application/json" } })).status()).toBe(401);
        expect((await second.request.get(origin + "/api/me", { headers: { accept: "application/json" } })).status()).toBe(200);
        expect(errors).toEqual([]);
        report.push({ width, locale, surface, logoutRequests, workspaceRequests, restarts });
      } finally { await context.close(); }
    }
    expect(workerCalls).toBe(0);
    await second.close();
    console.log(JSON.stringify({ accountAccessAcceptance: report, workerCalls }));
  } finally {
    await browser?.close(); await platform.close(); await workerManager.close(); await authStore.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
