// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_APPEARANCE_ACCEPTANCE)("workbench appearances persist while the centered login stays fixed across phone layouts", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { CliRuntimeManager } = await module("cli-runtime");
  const { PlatformServer } = await module("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-appearance-"));
  let platform, browser;
  try {
    const codexHome = join(root, "codex"); await mkdir(codexHome);
    await writeFile(join(codexHome, "config.toml"), 'model = "fixture-model"\n');
    const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
    const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
    const runtime = new CliRuntimeManager({ rootDir: join(root, "cli"), runtime: "codex", assistantAuthority: { inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) }, codexHome, claudeConfigDir: join(root, "claude"), codexCommand: process.execPath, codexArgs: [resolve("../../services/platform/fixtures/fake-cli.mjs"), "codex"] });
    platform = new PlatformServer({ authStore, workerManager, cliRuntime: runtime, webRoot: process.env.OSD_WEB_CANDIDATE });
    const address = await platform.listen(); const origin = `http://${address.host}:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const output = resolve("../../.deploy/verification/appearance"); await mkdir(output, { recursive: true });
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, locale: "en-US", colorScheme: "light", reducedMotion: "reduce" });
      try {
        await context.addInitScript(() => { localStorage.setItem("ai4s.locale", "en"); localStorage.setItem("scikeel.login.locale", "en"); });
        const page = await context.newPage(); const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.goto(origin + "/login");
        expect(await page.locator("[data-campus-login]").isVisible()).toBe(false);
        expect(await page.locator('link[rel="icon"]').count()).toBe(1);
        const pngHref = await page.locator('link[rel="icon"][type="image/png"]').getAttribute("href");
        expect(pngHref).toMatch(/^data:image\/png;base64,/);
        const decodedIcon = await page.evaluate(async href => {
          const image = new Image(); image.src = href; await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight };
        }, pngHref);
        expect(decodedIcon).toEqual({ width: 32, height: 32 });
        for (const path of ["/favicon.ico", "/apple-touch-icon.png"]) {
          const response = await context.request.get(origin + path, { maxRedirects: 0 });
          expect(response.status()).toBe(200);
          expect(response.headers()["cache-control"]).toBe("no-cache");
        }
        const login = await context.request.post(origin + "/auth/login", { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
        expect(login.status()).toBe(200);
        const { user } = await login.json();
        const instanceId = `user-${user.id}`;
        await workerManager.ensureWorker({ instanceId, userId: user.id });
        // The isolated legacy fake has no launcher; its simulated owned generation is fixed.
        workerManager.workers.get(instanceId).generation = 1;
        await page.goto(origin + "/settings/appearance");
        await page.getByRole("radio", { name: "Light", exact: true }).waitFor();
        expect(await page.getByRole("radio").count()).toBe(4);
        for (const [name, resolved] of [["Light", "light"], ["Dark", "dark"], ["System", "light"], ["CDUT", "cdut"]]) {
          await page.getByRole("radio", { name, exact: true }).click();
          await page.waitForFunction(value => document.documentElement.dataset.theme === value, resolved);
          expect(await page.locator("[data-campus-signature]").count()).toBe(0);
          await noOverflow();
        }
        await page.emulateMedia({ colorScheme: "dark" });
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        expect(await page.locator("html").getAttribute("data-theme")).toBe("cdut");
        await page.reload(); await page.getByRole("radio", { name: "CDUT", exact: true }).waitFor();
        expect(await page.getByRole("radio", { name: "CDUT", exact: true }).getAttribute("aria-checked")).toBe("true");
        expect(await page.locator('[src="/assets/brand/cdut-emblem.png"]').count()).toBe(0);
        await page.screenshot({ path: join(output, `settings-${width}.png`), fullPage: true });
        await page.goto(origin + "/live"); await page.locator("textarea").first().waitFor();
        await page.getByTestId("campus-empty-decoration").waitFor();
        await page.locator("[data-campus-motto]").evaluate(img => img.decode());
        const decoration = await page.getByTestId("campus-empty-decoration").boundingBox();
        const motto = await page.locator("[data-campus-motto]").boundingBox();
        const horizontalOffset = motto.x + motto.width / 2 - decoration.x - decoration.width / 2;
        const verticalOffset = motto.y + motto.height / 2 - decoration.y - decoration.height / 2;
        expect(decoration.height).toBeGreaterThan(200);
        expect(Math.abs(horizontalOffset)).toBeLessThanOrEqual(.5);
        expect(Math.abs(verticalOffset)).toBeLessThanOrEqual(.5);
        await writeFile(join(output, `motto-alignment-${width}.json`), JSON.stringify({ decoration, motto, horizontalOffset, verticalOffset }, null, 2));
        if (width === 1440) {
          const mark = await page.locator("[data-brand-home] [data-brand-mark]").boundingBox();
          const name = await page.locator("[data-brand-home] [data-brand-name]").boundingBox();
          expect(Math.abs(mark.y + mark.height / 2 - name.y - name.height / 2)).toBeLessThanOrEqual(.5);
          expect(name.x).toBeGreaterThan(mark.x + mark.width);
          await writeFile(join(output, "brand-alignment.json"), JSON.stringify({ mark, name, centerOffset: mark.y + mark.height / 2 - name.y - name.height / 2 }, null, 2));
        }
        await page.screenshot({ path: join(output, `empty-${width}.png`), fullPage: true });
        const input = page.locator("textarea").first(); await input.fill("Appearance fixture draft");
        const switchAppearance = async () => { await page.keyboard.press("Control+k"); await page.getByText("Switch appearance", { exact: true }).click(); };
        await switchAppearance();
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
        expect(await input.inputValue()).toBe("Appearance fixture draft");
        expect(await page.getByTestId("campus-empty-decoration").count()).toBe(0);
        await switchAppearance(); await switchAppearance();
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
        expect(await input.inputValue()).toBe("Appearance fixture draft");
        await switchAppearance();
        await input.fill("Appearance fixture message"); await input.press("Enter");
        await page.getByText("Appearance fixture message", { exact: true }).first().waitFor();
        expect(await page.getByTestId("campus-empty-decoration").count()).toBe(0);
        await noOverflow();
        await page.screenshot({ path: join(output, `conversation-${width}.png`), fullPage: true });
        // Hold the app module so the actual server-generated preparation overlay can be inspected.
        let releaseModule;
        const moduleGate = new Promise(done => { releaseModule = done; });
        await page.route("**/assets/**", async route => {
          if (new URL(route.request().url()).pathname.endsWith(".js")) await moduleGate;
          await route.continue();
        });
        await page.evaluate(() => sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale: "en", startedAt: Date.now() })));
        await page.goto(origin + "/live", { waitUntil: "commit" });
        await page.locator("#scikeel-login-preparation").waitFor();
        expect(await page.locator("#scikeel-login-preparation").getAttribute("data-theme")).toBe("light");
        expect(await page.locator("#scikeel-login-preparation [data-campus-login]").count()).toBe(0);
        await noOverflow();
        await page.screenshot({ path: join(output, `preparation-${width}.png`), fullPage: true });
        releaseModule(); await page.unrouteAll({ behavior: "wait" });
        await page.locator("textarea").first().waitFor();
        await context.request.post(origin + "/auth/logout", { headers: { accept: "application/json" } });
        await page.goto(origin + "/login");
        expect(await page.locator("[data-campus-login]").count()).toBe(0);
        const card = await page.locator(".card").boundingBox();
        expect(Math.abs(card.x + card.width / 2 - width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(card.y + card.height / 2 - 475)).toBeLessThanOrEqual(1);
        await noOverflow(); await page.screenshot({ path: join(output, `login-${width}.png`), fullPage: true });
        for (const appearance of ["cdut", "light", "dark", "system", "warm"]) {
          await page.evaluate(value => localStorage.setItem("ai4s.theme.v2", value), appearance);
          await page.reload();
          expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
          expect(await page.locator("body").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
          expect(await page.locator("[data-campus-login]").count()).toBe(0);
          const contrast = await page.locator(".submit").evaluate(button => {
            const style = getComputedStyle(button);
            const luminance = value => {
              const channels = value.match(/[\d.]+/g).slice(0, 3).map(v => Number(v) / 255)
                .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
              return channels.reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            };
            const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
            return (values[1] + .05) / (values[0] + .05);
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
          await noOverflow();
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await platform?.close(); await rm(root, { recursive: true, force: true }); }
}, 180000);
