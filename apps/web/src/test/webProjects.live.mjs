import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect } from "vitest";

/** Real provider calls are opt-in; credentials and browser storage never leave memory. */
export async function verifyLiveProjects() {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let original;
  let codexEnabled;
  const evidence = [];
  try {
    const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
    expect(login.status()).toBe(200);
    original = (await (await context.request.get(`${origin}/api/runtime`)).json()).runtime;
    codexEnabled = (await (await context.request.get(`${origin}/api/admin/runtime`)).json()).assistantEnabled.codex;
    if (!codexEnabled) expect((await context.request.post(`${origin}/api/admin/runtime`, { data: { runtime: "codex", enabled: true } })).status()).toBe(200);
    await context.addInitScript(() => localStorage.setItem("ai4s.locale", "en"));
    for (const runtime of ["opencode", "codex"]) {
      expect((await context.request.post(`${origin}/api/runtime`, { data: { runtime } })).status()).toBe(200);
      const page = await context.newPage();
      try {
        const errors = []; let creates = 0; let turns = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/projects") creates++;
          if (request.method() === "POST" && /\/prompt_async$/.test(new URL(request.url()).pathname)) turns++;
        });
        await page.goto(`${origin}/projects`);
        const openSidebar = async () => {
          const expand = page.getByRole("button", { name: /Expand sidebar/ }).first();
          if (await expand.isVisible()) await expand.click();
        };
        await openSidebar();
        const name = `Project acceptance ${runtime} ${Date.now()}`;
        await page.getByRole("button", { name: "New project", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Name project" });
        await dialog.getByRole("textbox").fill(name);
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        try {
          await dialog.waitFor({ state: "hidden", timeout: 60_000 });
        } catch (error) {
          console.error("Project entry controls:", await page.getByRole("dialog").allTextContents());
          throw error;
        }
        const projects = await (await context.request.get(`${origin}/v1/projects`)).json();
        const project = projects.find((item) => item.name === name);
        expect(project?.path).toBeTruthy();
        if (runtime === "opencode") {
          // Use the same authorized free model as the release gate; never probe Claude.
          const model = page.getByRole("button", { name: /^Model:/ });
          await expect.poll(() => model.isEnabled(), { timeout: 60_000 }).toBe(true);
          if (!(await model.getAttribute("aria-label")).includes("Big Pickle")) {
            await model.click();
            await page.getByRole("menuitem", { name: "Big Pickle", exact: true }).click();
          }
          expect(await model.getAttribute("aria-label")).toContain("Big Pickle");
        }
        const marker = `SCIKEELPROJECT${runtime.toUpperCase()}${Date.now()}`;
        const file = "project-acceptance.txt";
        await page.locator("textarea").fill(`Create ${file} in the current project workspace containing exactly ${marker}. Use the file-writing tool, request approval if required, and do not access other directories or use network. After writing the file, reply with exactly ${marker}.`);
        const send = page.getByRole("button", { name: "Send", exact: true });
        await expect.poll(() => send.isEnabled(), { timeout: 60_000 }).toBe(true);
        await send.click();
        await expect.poll(() => new URL(page.url()).pathname.startsWith("/live/ses_"), { timeout: 60_000 }).toBe(true);
        const sessionId = new URL(page.url()).pathname.split("/").pop();
        const scope = `?directory=${encodeURIComponent(project.path)}`;
        const deadline = Date.now() + 180_000;
        let messages;
        while (Date.now() < deadline) {
          const allow = page.getByRole("button", { name: "Allow once", exact: true });
          if (await allow.first().isVisible() && await allow.first().isEnabled()) await allow.first().click();
          const decision = page.getByRole("button", { name: "Continue with the suggestion", exact: true });
          if (await decision.first().isVisible() && await decision.first().isEnabled()) await decision.first().click();
          const response = await context.request.get(`${origin}/session/${sessionId}/message${scope}`);
          if (response.ok()) {
            messages = await response.json();
            if (messages.some((message) => message.info?.role === "assistant" && message.info?.time?.completed && message.parts?.some((part) => part.type === "text" && part.text?.includes(marker)))) break;
          }
          await page.waitForTimeout(500);
        }
        expect(messages?.some((message) => message.info?.role === "assistant" && message.parts?.some((part) => part.type === "text" && part.text?.includes(marker)))).toBe(true);
        try {
          await page.getByText(marker, { exact: true }).first().waitFor({ timeout: 15_000 });
        } catch (error) {
          await mkdir(resolve("../../.deploy/verification/web-projects"), { recursive: true });
          await page.screenshot({ path: resolve(`../../.deploy/verification/web-projects/live-failed-${runtime}.png`), fullPage: true });
          console.error("Live reply diagnostics:", { markerVisible: (await page.locator("body").innerText()).includes(marker), url: new URL(page.url()).pathname });
          throw error;
        }
        const session = await (await context.request.get(`${origin}/session/${sessionId}${scope}`)).json();
        expect(session.directory).toBe(project.path);
        const read = await context.request.get(`${origin}/v1/fs/read?dir=${encodeURIComponent(project.path)}&path=${file}`);
        expect(read.status()).toBe(200); expect((await read.text()).trim()).toBe(marker);
        const denied = await context.request.get(`${origin}/v1/fs/read?dir=${encodeURIComponent("/etc")}&path=hostname`);
        expect([400, 403]).toContain(denied.status());
        for (const width of [1280, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.reload();
          await page.getByText(marker, { exact: true }).first().waitFor({ timeout: 60_000 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await openSidebar();
          expect(await page.getByRole("button", { name: "New project", exact: true }).first().isEnabled()).toBe(true);
          await mkdir(resolve("../../.deploy/verification/web-projects"), { recursive: true });
          await page.screenshot({ path: resolve(`../../.deploy/verification/web-projects/live-${runtime}-${width}.png`), fullPage: true });
        }
        expect(creates).toBe(1); expect(turns).toBe(1); expect(errors).toEqual([]);
        evidence.push({ runtime, projectId: project.id, directory: project.path, sessionId, views: [1280, 390, 320], streamedReply: true, scopedFile: true, status: "passed" });
      } finally { await page.close(); }
    }
    await writeFile(resolve("../../.deploy/verification/web-projects/live.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), evidence }, null, 2));
  } finally {
    try {
      if (original) expect((await context.request.post(`${origin}/api/runtime`, { data: { runtime: original } })).status()).toBe(200);
    } finally {
      try {
        if (codexEnabled === false) expect((await context.request.post(`${origin}/api/admin/runtime`, { data: { runtime: "codex", enabled: false } })).status()).toBe(200);
      } finally { await context.close(); await browser.close(); }
    }
  }
}
