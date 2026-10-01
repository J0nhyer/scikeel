// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Opt-in deployment acceptance; browser binaries and credentials stay outside
// the repository. Run through the guarded desktop test script.
test.skipIf(!process.env.OSD_WEB_ACCEPTANCE)("finds, previews and downloads research papers at desktop and phone widths", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const output = resolve("../../.deploy/verification");
  await mkdir(output, { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", acceptDownloads: true });
      const page = await context.newPage();
      const failures = [];
      page.on("response", (response) => { if (response.url().includes("/v1/fs/") && response.status() >= 400) failures.push(response.status()); });
      const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
      expect(login.status()).toBe(200);
      const { user } = await login.json();
      const workspace = resolve(`../../.deploy/platform-data/workers/instances/user-${user.id}/workspace`);
      const ticket = await context.request.get(`${origin}/v1/fs/ticket?path=papers%2Fcnn-study-notes.md&dir=${encodeURIComponent(workspace)}`);
      expect(ticket.status()).toBe(200);
      const forbidden = await context.request.get(`${origin}/v1/fs/ticket?path=package.json&dir=${encodeURIComponent(resolve("../.."))}`);
      expect(forbidden.status()).toBe(404);
      const anotherUser = resolve("../../.deploy/platform-data/workers/instances/user-usr_92b039da51af00d8da82e650/workspace");
      const crossed = await context.request.get(`${origin}/v1/fs/list?dir=${encodeURIComponent(anotherUser)}&path=`);
      expect(crossed.status()).toBe(400);
      await page.goto(`${origin}/files`);
      if (width === 1280) {
        // Asset listing comes from the deployed bundle, not a development module.
        const { readdir } = await import("node:fs/promises");
        const assets = await readdir(resolve("dist/assets"));
        const result = await page.evaluate(async ({ origin, assets }) => {
          const dynamicImport = new Function("url", "return import(url)");
          const load = async (name) => dynamicImport(`${origin}/assets/${assets.find((file) => file.startsWith(`${name}-`) && file.endsWith(".js"))}`);
          const molecule = await load("openchemlib");
          const viewer = await load("3dmol");
          const workbook = await load("exceljs");
          const docx = await load("docx-preview");
          return { atoms: molecule.Molecule.fromSmiles("CCO").getAllAtoms(), viewer: typeof viewer.createViewer, sheets: new workbook.default.Workbook().worksheets.length, docx: typeof docx.renderAsync };
        }, { origin, assets });
        expect(result).toEqual({ atoms: 3, viewer: "function", sheets: 0, docx: "function" });
      }
      await page.getByText("papers", { exact: true }).click();
      await page.getByText("cnn-study-notes.md", { exact: true }).waitFor();
      await page.screenshot({ path: `${output}/workspace-files-${width}.png` });
      const names = ["lecun1998-gradient-based-learning-document-recognition.pdf", "krizhevsky2012-imagenet-deep-cnns.pdf"];
      for (const name of names) {
        const received = page.waitForEvent("download");
        await page.getByRole("button", { name: `Download: ${name}`, exact: true }).click();
        const download = await received;
        expect(download.suggestedFilename()).toBe(name);
        const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
        expect(hash(await readFile(await download.path()))).toBe(hash(await readFile(`${workspace}/papers/${name}`)));
      }
      await page.getByText("cnn-study-notes.md", { exact: true }).click();
      await page.getByRole("heading", { name: /卷积神经网络学习笔记/ }).waitFor();
      await page.screenshot({ path: `${output}/workspace-notes-${width}.png` });
      await page.goto(`${origin}/files`);
      await page.getByText(names[0], { exact: true }).click();
      const canvas = page.getByRole("img", { name: "PDF page 1 of 46", exact: true });
      await canvas.waitFor();
      await expect.poll(() => canvas.getAttribute("aria-busy"), { timeout: 20_000 }).toBe("false");
      const inkPixels = async (target) => target.evaluate((element) => {
        const { data } = element.getContext("2d").getImageData(0, 0, element.width, element.height);
        let ink = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) ink++;
        return ink;
      });
      expect(await inkPixels(canvas)).toBeGreaterThan(1000);
      await page.screenshot({ path: `${output}/workspace-pdf-${width}.png` });
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      const nextCanvas = page.getByRole("img", { name: "PDF page 2 of 46", exact: true });
      await expect.poll(() => nextCanvas.getAttribute("aria-busy"), { timeout: 20_000 }).toBe("false");
      await expect.poll(() => inkPixels(nextCanvas), { timeout: 15_000 }).toBeGreaterThan(1000);
      const originalWidth = await nextCanvas.evaluate((element) => element.width);
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect.poll(() => nextCanvas.getAttribute("aria-busy"), { timeout: 20_000 }).toBe("false");
      await expect.poll(() => nextCanvas.evaluate((element) => element.width), { timeout: 15_000 }).toBeGreaterThan(originalWidth);
      expect(await nextCanvas.evaluate((element) => element.width * element.height)).toBeLessThan(6_020_000);
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      await expect.poll(() => nextCanvas.getAttribute("aria-busy"), { timeout: 20_000 }).toBe("false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.goto(`${origin}/files`);
      await page.getByText(names[1], { exact: true }).click();
      const alexNetCanvas = page.getByRole("img", { name: "PDF page 1 of 9", exact: true });
      await alexNetCanvas.waitFor();
      await expect.poll(() => inkPixels(alexNetCanvas), { timeout: 20_000 }).toBeGreaterThan(1000);
      await page.screenshot({ path: `${output}/workspace-alexnet-${width}.png` });
      expect(failures).toEqual([]);
      await page.goto(`${origin}/live/ses_f0ea30b56ffeWSU1iXjVLcuH87`);
      const currentModel = page.getByRole("button", { name: /^Model:/ }).last();
      await currentModel.waitFor();
      if (!/Big Pickle|big-pickle/.test(await currentModel.getAttribute("aria-label"))) {
        await currentModel.click();
        await page.getByRole(width <= 768 ? "button" : "menuitem", { name: /Big Pickle|big-pickle/ }).last().click();
      }
      const modelButton = page.getByRole("button", { name: /Model:.*Big Pickle|Model:.*big-pickle/ }).last();
      await modelButton.waitFor();
      expect(await page.getByRole("button", { name: /^Reasoning effort:/ }).count()).toBe(0);
      await modelButton.click();
      const modelOptions = page.getByRole(width === 390 ? "button" : "menuitem", { name: /LongCat|longcat-2.5/ });
      await modelOptions.last().click();
      const effort = page.getByRole("button", { name: /^Reasoning effort:/ }).last();
      await effort.waitFor();
      await effort.click();
      await page.getByRole(width === 390 ? "button" : "menuitem", { name: "High", exact: true }).click();
      expect(await effort.getAttribute("aria-label")).toBe("Reasoning effort: High");
      for (const viewportWidth of width === 1280 ? [480, 768, 1024, 1280, 1440, 1920] : [320, 390]) {
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        await expect.poll(async () => {
          const bounds = await effort.boundingBox();
          const modelBounds = await page.getByRole("button", { name: /Model:.*LongCat|Model:.*longcat-2.5/ }).last().boundingBox();
          return !!bounds && !!modelBounds && bounds.x >= modelBounds.x + modelBounds.width &&
            Math.abs(bounds.y - modelBounds.y) < 1 && bounds.width === 40 &&
            bounds.x + bounds.width <= viewportWidth;
        }).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await effort.click();
        const isMobile = viewportWidth <= 768;
        const high = page.getByRole(isMobile ? "button" : "menuitem", { name: "High", exact: true });
        await high.waitFor();
        const menuBounds = await high.boundingBox();
        expect(menuBounds.x).toBeGreaterThanOrEqual(0);
        expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewportWidth);
        await high.click();
        await page.screenshot({ path: `${output}/workspace-effort-${viewportWidth}.png` });
      }
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: /Model:.*LongCat|Model:.*longcat-2.5/ }).last().click();
      await page.getByRole(width === 390 ? "button" : "menuitem", { name: /Big Pickle|big-pickle/ }).last().click();
      expect(await page.getByRole("button", { name: /^Reasoning effort:/ }).count()).toBe(0);
      await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}, 90_000);

test.skipIf(!process.env.OSD_CLI_ACCEPTANCE)("runs real Codex with explicit effort then returns to its profile default", async () => {
  const { CliRuntimeManager } = await import("../../../../services/platform/src/cli-runtime.mjs");
  const root = await mkdtemp(resolve(tmpdir(), "osd-effort-"));
  const workspace = `${root}/workspace`;
  await mkdir(workspace);
  const manager = new CliRuntimeManager({ rootDir: `${root}/runtime`, turnTimeoutMs: 60_000 });
  try {
    await manager.init();
    await manager.setUserRuntime("effort-verification", "codex");
    const session = await manager.createSession({ userId: "effort-verification", workspaceDir: workspace });
    const profile = manager.profiles.get("codex");
    const model = profile.models.find((entry) => entry.id === profile.defaultModel);
    expect(model.variants.low).toBeDefined();
    for (const variant of ["low", undefined]) {
      await manager.sendPrompt({ userId: session.userId, sessionId: session.id, text: "Reply with exactly EFFORT_OK. Do not use tools or edit files.", variant });
      const deadline = Date.now() + 65_000;
      while (session.status === "running" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
      expect(session.status).toBe("idle");
      expect(session.variant).toBe(variant ?? null);
      const assistant = session.history.filter((message) => message.info.role === "assistant").at(-1);
      expect(assistant.info.error).toBeUndefined();
      expect(assistant.parts.some((part) => part.type === "text" && part.text.includes("EFFORT_OK"))).toBe(true);
    }
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
