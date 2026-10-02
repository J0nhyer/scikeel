// @vitest-environment node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_LOGIN_ACCEPTANCE)("localized Web login works on desktop, phone and without JavaScript", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { PlatformServer } = await module("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-login-"));
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  const platform = new PlatformServer({ authStore, workerManager });
  const address = await platform.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  try {
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${origin}/login?next=/health`);
        expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hans");
        expect(await page.getByRole("heading", { name: "\u767b\u5f55\u7814\u7a76\u5de5\u4f5c\u53f0" }).isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.getByRole("button", { name: "\u767b\u5f55", exact: true }).click();
        expect(await page.locator("#username").evaluate(element => element.validationMessage)).toBe("\u8bf7\u8f93\u5165\u7528\u6237\u540d\u3002");
        await page.getByLabel("\u7528\u6237\u540d", { exact: true }).fill("fixture");
        await page.getByLabel("\u5bc6\u7801", { exact: true }).fill("wrong-password");
        await page.getByRole("button", { name: "\u663e\u793a\u5bc6\u7801", exact: true }).click();
        expect(await page.locator("#password").getAttribute("type")).toBe("text");
        await page.getByRole("button", { name: "\u9690\u85cf\u5bc6\u7801", exact: true }).click();
        await page.getByRole("link", { name: "English", exact: true }).click();
        expect(await page.locator("#username").inputValue()).toBe("fixture");
        expect(await page.locator("#password").inputValue()).toBe("wrong-password");
        const rejected = page.waitForResponse(response => response.url().endsWith("/auth/login"));
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        expect((await rejected).status()).toBe(401);
        await page.getByRole("alert").waitFor();
        expect(await page.locator("html").getAttribute("lang")).toBe("en");
        expect(await page.locator("#username").inputValue()).toBe("fixture");
        expect(await page.locator("#password").inputValue()).toBe("");
        await page.getByRole("link", { name: "\u7b80\u4f53\u4e2d\u6587" }).click();
        expect(await page.getByRole("alert").innerText()).toContain("\u7528\u6237\u540d\u6216\u5bc6\u7801\u4e0d\u6b63\u786e");
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/login-${width}-zh-error.png`), fullPage: true });
        await page.goto(`${origin}/login?next=/health`);
        expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hans");
        await page.screenshot({ path: resolve(`../../.deploy/verification/login-${width}-zh.png`), fullPage: true });
        await page.getByRole("link", { name: "English", exact: true }).click();
        await page.screenshot({ path: resolve(`../../.deploy/verification/login-${width}-en.png`), fullPage: true });
        await page.goto(`${origin}/login?next=/health`);
        expect(await page.locator("html").getAttribute("lang")).toBe("en");
        await page.getByRole("link", { name: "\u7b80\u4f53\u4e2d\u6587" }).click();
        await page.getByLabel("\u7528\u6237\u540d", { exact: true }).fill("fixture");
        await page.getByLabel("\u5bc6\u7801", { exact: true }).fill("fixture-password");
        await Promise.all([page.waitForURL(`${origin}/health`), page.getByRole("button", { name: "\u767b\u5f55", exact: true }).click()]);
        expect(await page.evaluate(() => localStorage.getItem("ai4s.locale"))).toBe("zh-Hans");
        expect((await context.cookies()).some(cookie => cookie.name === "osd_session" && cookie.httpOnly)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/login?next=/health`);
      expect(await page.getByRole("button", { name: "\u663e\u793a\u5bc6\u7801" }).isVisible()).toBe(false);
      await page.getByRole("link", { name: "English", exact: true }).click();
      expect(await page.locator("html").getAttribute("lang")).toBe("en");
      await page.getByLabel("Username", { exact: true }).fill("fixture");
      await page.getByLabel("Password", { exact: true }).fill("fixture-password");
      await Promise.all([page.waitForURL(`${origin}/health`), page.getByRole("button", { name: "Sign in", exact: true }).click()]);
    } finally { await context.close(); }
  } finally {
    await browser.close(); await platform.close(); await workerManager.close(); await authStore.close(); await rm(root, { recursive: true, force: true });
  }
}, 60000);
