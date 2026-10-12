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
    for (const width of [1280, 390, 320]) for (const surface of ["known", "unknown", "preparation"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        expect((await login(context)).status()).toBe(200);
        await context.addInitScript(preparing => {
          localStorage.setItem("ai4s.locale", "en");
          if (preparing) sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale: "en", startedAt: Date.now() }));
        }, surface === "preparation");
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let workspaceRequests = 0; let logoutRequests = 0;
        await page.route("**/v1/whoami", route => {
          workspaceRequests++;
          return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Unavailable workspace" }) });
        });
        if (surface === "unknown") await page.route("**/api/me", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
        await page.route("**/auth/logout", route => ++logoutRequests === 1
          ? route.fulfill({ status: 502, contentType: "application/json", body: "{}" }) : route.continue());
        await page.goto(origin + "/live");
        if (surface === "preparation") {
          const earlySignOut = page.getByRole("button", { name: "Sign out", exact: true });
          await earlySignOut.waitFor(); expect(await earlySignOut.isEnabled()).toBe(true);
          await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
          expect(await page.locator("#root").evaluate(element => element.inert)).toBe(true);
          expect(await page.locator("#scikeel-login-preparation input:not([type=hidden])").count()).toBe(2);
          expect(await page.locator("#scikeel-login-preparation input").evaluateAll(elements => elements.every(element => element.disabled && !element.value))).toBe(true);
        } else {
          if (width < 768) await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
          if (surface === "known") await page.getByRole("button", { name: "fixture account", exact: true }).click();
          else expect(await page.getByRole("menuitem", { name: "Settings", exact: true }).count()).toBe(0);
        }
        const signOut = page.getByRole(surface === "known" ? "menuitem" : "button", { name: "Sign out", exact: true });
        await signOut.waitFor();
        expect(await signOut.isEnabled()).toBe(true);
        await signOut.click();
        await page.getByText("Could not sign out. Please retry.", { exact: true }).waitFor();
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
        await page.screenshot({ path: join(screenshots, `account-${surface}-${width}.png`), fullPage: true });
        await Promise.all([page.waitForURL(origin + "/login"), signOut.click()]);
        expect(logoutRequests).toBe(2);
        expect((await context.request.get(origin + "/api/me", { headers: { accept: "application/json" } })).status()).toBe(401);
        expect((await second.request.get(origin + "/api/me", { headers: { accept: "application/json" } })).status()).toBe(200);
        expect(errors).toEqual([]);
        report.push({ width, surface, logoutRequests, workspaceRequests });
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
