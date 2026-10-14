// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_RESEARCH_DEPLOYED_ACCEPTANCE)("renders the deployed Web conversation without the withdrawn research form", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const httpOrigin = new URL(origin);
  httpOrigin.protocol = "http:";
  httpOrigin.hostname = "scikeel-http.test";
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", `--host-resolver-rules=MAP scikeel-http.test ${new URL(origin).hostname}`], headless: true });
  try {
    const scenarios = [origin, httpOrigin.origin].flatMap((pageOrigin) => [1280, 390].map((width) => ({ pageOrigin, width })));
    for (const { pageOrigin, width } of scenarios) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
        expect(login.status()).toBe(200);
        const result = await context.request.get(`${origin}/api/research/ses_research_deployed_readonly_check`);
        expect(result.status()).toBe(200);
        expect((await result.json()).task).toBe(null);
        if (pageOrigin !== origin) {
          const state = await context.storageState();
          await context.addCookies(state.cookies.map((cookie) => ({ ...cookie, domain: httpOrigin.hostname })));
        }
        const chinese = width === 390;
        await context.addInitScript((locale) => localStorage.setItem("ai4s.locale", locale), chinese ? "zh-Hans" : "en");
        const page = await context.newPage();
        let turns = 0;
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => { if (request.method() === "POST" && /\/session\/[^/]+\/prompt/.test(request.url())) turns++; });
        await page.goto(`${pageOrigin}/live`);
        if (pageOrigin !== origin) expect(await page.evaluate(() => isSecureContext)).toBe(false);
        await page.locator("textarea").waitFor({ state: "visible" });
        const idea = page.getByRole("button", { name: chinese ? /从想法开始科研/ : /Start from a research idea/ });
        await idea.waitFor({ state: "visible" });
        expect(await idea.locator("..").getByRole("button").count()).toBe(5);
        expect(await page.getByRole("button", { name: chinese ? "开始一个科研任务" : "Start a research task", exact: true }).count()).toBe(0);
        expect(await page.getByLabel(chinese ? "科研目标" : "Research objective", { exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(turns).toBe(0);
        expect(errors).toEqual([]);
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/research-deployed-${pageOrigin === origin ? "local" : "http"}-${width}.png`), fullPage: true });
      } finally {
        await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.OSD_RESEARCH_STARTER_ACCEPTANCE)("starts research guidance through the existing Web starter group and sends one ordinary conversation turn", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { CliRuntimeManager } = await module("cli-runtime");
  const { PlatformServer } = await module("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-research-starter-"));
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), 'model = "fixture-model"\n');
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome, codexCommand: process.execPath, codexArgs: [resolve("../../services/platform/fixtures/fake-cli.mjs"), "codex"] });
  const platform = new PlatformServer({ authStore, workerManager, cliRuntime, webRoot: resolve("dist") });
  const address = await platform.listen();
  const origin = `http://${address.host}:${address.port}`;
  const pageOrigin = `http://scikeel-http.test:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server", "--host-resolver-rules=MAP scikeel-http.test 127.0.0.1"], headless: true });
  try {
    for (const width of [1280, 390]) for (const chinese of [false, true]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
        expect(login.status()).toBe(200);
        const { user } = await login.json();
        await cliRuntime.setUserRuntime(user.id, "codex");
        const state = await context.storageState();
        await context.addCookies(state.cookies.map((cookie) => ({ ...cookie, domain: "scikeel-http.test" })));
        await context.addInitScript((locale) => localStorage.setItem("ai4s.locale", locale), chinese ? "zh-Hans" : "en");
        const page = await context.newPage();
        const errors = [];
        const turns = [];
        let researchWrites = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() !== "POST") return;
          if (/\/session\/[^/]+\/prompt_async/.test(request.url())) turns.push(request.postDataJSON());
          if (/\/api\/research\//.test(request.url())) researchWrites++;
        });
        await page.goto(`${pageOrigin}/live`);
        const idea = page.getByRole("button", { name: chinese ? /从想法开始科研/ : /Start from a research idea/ });
        await idea.waitFor({ state: "visible" });
        expect(await idea.locator("..").getByRole("button").count()).toBe(5);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/research-starter-${width}-${chinese ? "zh" : "en"}.png`), fullPage: true });
        await idea.click();
        await expect.poll(() => turns.length, { timeout: 10_000 }).toBe(1);
        await page.getByText(/Codex\[fixture-model\]:/).first().waitFor({ state: "visible" });
        expect(turns[0].parts[0].text).toContain(chinese ? "最多三个" : "at most three");
        expect(turns[0].parts[0].text).toContain(chinese ? "等我回答" : "wait for my answers");
        expect(researchWrites).toBe(0);
        expect(await page.getByRole("checkbox").count()).toBe(0);
        expect(await idea.count()).toBe(0);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await platform.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!process.env.OSD_REAL_RESEARCH_ACCEPTANCE)("a real Codex research turn writes checked deliverables and the versioned task report", async () => {
  const { CliRuntimeManager } = await import(pathToFileURL(resolve("../../services/platform/src/cli-runtime.mjs")).href);
  const { ResearchTasks } = await import(pathToFileURL(resolve("../../services/platform/src/research-tasks.mjs")).href);
  const root = await mkdtemp(join(tmpdir(), "scikeel-real-research-"));
  const directory = join(root, "workspace");
  await mkdir(directory);
  await writeFile(join(directory, "data.csv"), "value\n1\n2\n3\n");
  const manager = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome: "/home/ubuntu/.codex", codexCommand: "/home/ubuntu/.nvm/versions/node/v24.16.0/bin/codex", turnTimeoutMs: 240_000 });
  const store = new ResearchTasks({ rootDir: join(root, "tasks"), cancel: (task) => manager.abortSession(task.userId, task.sessionId) });
  let timer;
  try {
    await manager.init();
    await manager.setUserRuntime("research_acceptance", "codex");
    const session = await manager.createSession({ userId: "research_acceptance", workspaceDir: directory });
    await store.create({ userId: "research_acceptance", sessionId: session.id, directory, workspaceDir: directory, runtime: "codex" }, { objective: "Read data.csv (values 1,2,3), compute its mean using Python standard library, preserve the source file, save analysis.py and report.md, run an actual verification with its evidence in verification.txt. This is a small demonstration, no dependencies or network needed.", mode: "delegated", goal: "thesis", inputs: ["data.csv"], deliverables: ["analysis.py", "report.md"], pageId: "test-page" });
    const body = await store.prepare("research_acceptance", session.id, { parts: [{ type: "text", text: "Complete this small task now. Read the supplied research-workflow Skill and write the required final progress JSON with actual checks and output paths before your final response." }] });
    timer = setInterval(() => void store.heartbeat("research_acceptance", session.id, "test-page"), 10_000);
    await manager.sendPrompt({ userId: "research_acceptance", sessionId: session.id, text: `${body.system}\n${body.parts[0].text}`, variant: "low" });
    const start = Date.now();
    while (session.status === "running" && Date.now() - start < 245_000) await new Promise((done) => setTimeout(done, 500));
    expect(session.status).toBe("idle");
    const task = await store.settled("research_acceptance", session.id);
    if (task.status !== "completed") console.log(JSON.stringify({ status: task.status, report: task.report, lastError: session.history.at(-1)?.info.error, parts: session.history.at(-1)?.parts.map((part) => ({ type: part.type, tool: part.tool, status: part.state?.status, text: part.text?.slice(0, 500), output: part.state?.output?.slice(0, 500) })) }));
    expect(task.status).toBe("completed");
    expect(task.report.artifacts.filter((a) => a.exists).map((a) => a.path)).toEqual(expect.arrayContaining(["analysis.py", "report.md"]));
    expect(task.report.checks.every((c) => c.status === "passed" && c.evidenceExists)).toBe(true);
    expect(await readFile(join(directory, "data.csv"), "utf8")).toBe("value\n1\n2\n3\n");
    console.log(`Real research task completed with ${task.report.artifacts.length} existing artifacts and ${task.report.checks.length} evidenced checks in ${Date.now() - start} ms`);
    await mkdir(resolve("../../.deploy/verification"), { recursive: true });
    await writeFile(resolve("../../.deploy/verification/research-real-result.json"), JSON.stringify({ status: task.status, artifacts: task.report.artifacts, checks: task.report.checks, milliseconds: Date.now() - start }, null, 2));
  } finally {
    clearInterval(timer);
    await store.close();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
}, 260_000);

test.skipIf(!process.env.OSD_RESEARCH_ACCEPTANCE)("runs student research modes with saved decisions and page-bound cancellation", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await module("auth-store");
  const { WorkerManager } = await module("worker-manager");
  const { CliRuntimeManager } = await module("cli-runtime");
  const { PlatformServer } = await module("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-research-browser-"));
  const codexHome = join(root, "codex");
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), 'model = "fixture-model"\n');
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome, codexCommand: process.execPath, codexArgs: [resolve("../../services/platform/fixtures/research-cli.mjs")] });
  const platform = new PlatformServer({ authStore, workerManager, cliRuntime, webRoot: resolve("dist") });
  const address = await platform.listen();
  const origin = `http://${address.host}:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const getTask = async (context, sid) => (await (await context.request.get(`${origin}/api/research/${sid}`)).json()).task;
  const waitTask = async (context, sid, predicate, timeout = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const task = await getTask(context, sid);
      if (predicate(task)) return task;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Research state did not settle: ${JSON.stringify(await getTask(context, sid))}`);
  };
  const launch = async (context, objective = "Reproducible baseline") => {
    const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
    const { user } = await login.json();
    await cliRuntime.setUserRuntime(user.id, "codex");
    const response = await context.request.post(`${origin}/session`, { data: { title: objective } });
    const { id } = await response.json();
    const directory = workerManager.instancePaths(`user-${user.id}`).workspaceDir;
    await writeFile(join(directory, "data.csv"), "value\n1\n2\n3\n");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/live/${id}`);
    return { id, directory, page, errors, user };
  };
  try {
    for (const width of [1280, 390]) for (const mode of ["guided", "collaborative", "delegated"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const chinese = width === 390;
        await context.addInitScript((locale) => localStorage.setItem("ai4s.locale", locale), chinese ? "zh-Hans" : "en");
        const { id, directory, page, errors } = await launch(context);
        await page.getByRole("button", { name: chinese ? "开始一个科研任务" : "Start a research task", exact: true }).click();
        await page.getByLabel(chinese ? "科研目标" : "Research objective", { exact: true }).fill("Reproducible baseline");
        const modeInput = page.getByLabel(chinese ? "工作模式" : "Working mode", { exact: true });
        expect(await modeInput.inputValue()).toBe("collaborative");
        await modeInput.selectOption(mode);
        await page.getByLabel(chinese ? "输入文件（可选，每行一个路径）" : "Input files (optional, one path per line)", { exact: true }).fill("data.csv");
        await page.getByLabel(chinese ? "我确认科研目标、输入材料与预期成果，任务在当前会话工作区内进行。" : "I confirm this objective, input files, and expected outputs within this conversation's workspace.", { exact: true }).check();
        await page.getByRole("button", { name: chinese ? "确认范围并开始" : "Confirm scope and start", exact: true }).click();
        if (mode !== "delegated") {
          await page.getByText("Confirm computing the mean from the supplied CSV?", { exact: true }).waitFor();
          await page.getByLabel(chinese ? "你的决定" : "Your decision", { exact: true }).fill("Confirmed; compute the actual mean");
          await page.getByRole("button", { name: chinese ? "确认决定" : "Confirm decision", exact: true }).click();
          await waitTask(context, id, (task) => task.decisions.length === 1);
          await page.reload();
          await page.getByRole("button", { name: chinese ? "继续科研任务" : "Continue research", exact: true }).waitFor();
          expect((await getTask(context, id)).decisions[0].answer).toBe("Confirmed; compute the actual mean");
          expect(cliRuntime.processes.size).toBe(0);
          await page.getByRole("button", { name: chinese ? "继续科研任务" : "Continue research", exact: true }).click();
        }
        const task = await waitTask(context, id, (task) => task.status === "completed" && !task.executionActive);
        expect(task.report.artifacts[0].exists).toBe(true);
        expect(task.report.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(await readFile(join(directory, "report.md"), "utf8")).toContain("Mean: 2");
        await page.getByRole("button", { name: "report.md", exact: true }).first().waitFor();
        // The worker fixture has no file-ticket service. Serve genuine fixture
        // outputs here while checking that the UI requests the owning directory.
        const fileLookups = [];
        await page.route("**/v1/fs/ticket?**", async (route) => {
          const url = new URL(route.request().url());
          fileLookups.push(url);
          expect(url.searchParams.get("dir")).toBe(directory);
          expect(url.searchParams.get("path")).toBe("report.md");
          await route.fulfill({ json: { ticket: "research-report-fixture" } });
        });
        await page.route("**/v1/fs/read?**", async (route) => {
          const url = new URL(route.request().url());
          expect(url.searchParams.get("ticket")).toBe("research-report-fixture");
          await route.fulfill({ body: await readFile(join(directory, "report.md")), contentType: "text/plain; charset=utf-8" });
        });
        await page.getByRole("button", { name: "report.md", exact: true }).first().click();
        await page.getByRole("heading", { name: "Baseline research report", exact: true }).waitFor();
        expect(fileLookups.length).toBeGreaterThan(0);
        expect((await getTask(context, id)).status).toBe("completed");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/research-${mode}-${width}.png`), fullPage: true });
        expect(errors).toEqual([]);
        await page.close();
        expect((await getTask(context, id)).status).toBe("completed");
      } finally { await context.close(); }
    }
    // Graceful exit must stop the actual process tree, not merely change a label.
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    try {
      const { id, directory, page } = await launch(context, "long-running research");
      await context.request.post(`${origin}/api/research/${id}`, { data: { action: "create", objective: "long-running research", goal: "thesis", mode: "delegated", inputs: ["data.csv"], deliverables: ["report.md"], pageId: "fixture-page" } });
      await page.reload();
      await page.getByRole("button", { name: "Continue research", exact: true }).waitFor();
      await page.getByRole("button", { name: "Continue research", exact: true }).click();
      await waitTask(context, id, (task) => task.executionActive);
      let child;
      for (let n = 0; n < 100; n++) {
        try { child = Number(await readFile(join(directory, "child.pid"), "utf8")); break; }
        catch { await new Promise((done) => setTimeout(done, 20)); }
      }
      expect(child).toBeTruthy();
      await context.request.post(`${origin}/api/research/${id}`, { data: { action: "release", pageId: "fixture-page" } });
      const closedAt = Date.now();
      await page.close();
      const stopped = await waitTask(context, id, (task) => task.status === "paused");
      expect(stopped.stopReason).toBe("page-closed");
      await new Promise((done) => setTimeout(done, 300));
      let childStopped = false;
      try { childStopped = /\) Z /.test(await readFile(`/proc/${child}/stat`, "utf8")); }
      catch { childStopped = true; }
      expect(childStopped).toBe(true);
      console.log(`Research graceful page-close cancellation: ${Date.now() - closedAt} ms`);
      expect(await readFile(join(directory, "data.csv"), "utf8")).toContain("1\n2\n3");
      // No heartbeat or exit event: emulate a browser disappearing mid-turn.
      await context.request.post(`${origin}/api/research/${id}`, { data: { action: "heartbeat", pageId: "abrupt-page" } });
      await context.request.post(`${origin}/session/${id}/prompt_async`, { data: { parts: [{ type: "text", text: "Continue" }] } });
      const lostAt = Date.now();
      await waitTask(context, id, (task) => task.status === "paused" && task.stopReason === "page-timeout", 50_000);
      expect(Date.now() - lostAt).toBeLessThan(48_000);
      console.log(`Research abrupt-disconnect cancellation: ${Date.now() - lostAt} ms`);
    } finally { await context.close(); }
  } finally {
    await browser.close();
    await platform.close();
    await cliRuntime.close();
    await workerManager.close();
    await authStore.close();
    await rm(root, { recursive: true, force: true });
  }
}, 160_000);

test.skipIf(!process.env.OSD_DOCUMENT_LINKS_ACCEPTANCE)("offers only existing answer documents and opens them in their owning workspace", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
        expect(login.status()).toBe(200);
        const { user } = await login.json();
        const directory = resolve(`../../.deploy/platform-data/workers/instances/user-${user.id}/workspace`);
        const id = "ses_acceptance_document_links";
        const created = Date.parse("2026-10-01T12:00:00Z");
        const missing = "planned_scikeel_acceptance_report.md";
        expect((await context.request.get(`${origin}/v1/fs/ticket?path=${missing}&dir=${encodeURIComponent(directory)}`)).status()).toBe(404);
        const page = await context.newPage();
        const errors = [];
        const lookups = [];
        let turns = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname === "/v1/fs/ticket") lookups.push(url);
        });
        await page.route("**/experimental/session?**", (route) => route.fulfill({ json: [{ id, title: "Document links acceptance", directory, time: { created, updated: created } }] }));
        await page.route(`**/session/${id}/message`, (route) => route.fulfill({ json: [
          { info: { id: "msg_documents_user", role: "user", time: { created } }, parts: [{ type: "text", text: "Show the research documents" }] },
          { info: { id: "msg_documents_assistant", role: "assistant", agent: "build", time: { created: created + 1, completed: created + 2 } },
            parts: [{ type: "text", text: `Existing document: \`papers/cnn-study-notes.md\`. Also named \`cnn-study-notes.md\`. Planned document: \`${missing}\`.` }] },
        ] }));
        await page.route("**/session/status**", (route) => route.fulfill({ json: {} }));
        await page.route("**/session/*/prompt_async", (route) => { turns++; return route.abort(); });
        await page.goto(`${origin}/live/${id}`);
        const scoped = page.getByTitle("Preview papers/cnn-study-notes.md", { exact: true });
        await scoped.waitFor();
        await page.getByTitle("Preview cnn-study-notes.md", { exact: true }).waitFor();
        expect(await page.getByRole("button", { name: missing, exact: true }).count()).toBe(0);
        expect(lookups.every((url) => url.searchParams.get("dir") === directory)).toBe(true);
        await scoped.click();
        await page.getByRole("heading", { name: /卷积神经网络学习笔记/ }).waitFor();
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toBe("cnn-study-notes.md");
        const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
        expect(digest(await readFile(await download.path()))).toBe(digest(await readFile(join(directory, "papers/cnn-study-notes.md"))));
        expect(await page.getByText("file not found", { exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
        expect(turns).toBe(0);
      } finally {
        await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.OSD_NATIVE_SKILLS_ACCEPTANCE)("discovers usable Claude and Codex skills in an isolated Web platform", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const platformModule = (name) => import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const { AuthStore } = await platformModule("auth-store");
  const { WorkerManager } = await platformModule("worker-manager");
  const { CliRuntimeManager } = await platformModule("cli-runtime");
  const { PlatformServer } = await platformModule("platform-server");
  const root = await mkdtemp(join(tmpdir(), "scikeel-native-skills-"));
  const claudeConfigDir = join(root, "claude");
  const codexHome = join(root, "codex");
  await mkdir(claudeConfigDir);
  await mkdir(codexHome);
  await writeFile(join(claudeConfigDir, "settings.json"), '{"model":"fixture-model"}');
  await writeFile(join(codexHome, "config.toml"), 'model = "fixture-model"\n');
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "fixture", password: "fixture-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers"), osdCommand: process.execPath, osdArgs: [resolve("../../services/platform/fixtures/fake-osd.mjs")] });
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), claudeConfigDir, codexHome, resourcesDir: resolve("../../.deploy/osd/current/resources") });
  const platform = new PlatformServer({ authStore, workerManager, cliRuntime, webRoot: resolve("dist") });
  const address = await platform.listen();
  const origin = `http://${address.host}:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  try {
    for (const runtime of ["claude", "codex"]) for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "fixture", password: "fixture-password" } });
        expect(login.status()).toBe(200);
        const { user } = await login.json();
        expect((await context.request.post(`${origin}/api/runtime`, { headers: { accept: "application/json" }, data: { runtime } })).status()).toBe(200);
        const workspace = workerManager.instancePaths(`user-${user.id}`).workspaceDir;
        const target = join(workspace, runtime === "claude" ? ".claude" : ".agents", "skills", "workspace-fixture");
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "SKILL.md"), "---\nname: workspace-fixture\ndescription: A workspace skill for browser acceptance.\n---\nRead the current workspace.\n");
        const chinese = width === 390;
        await context.addInitScript((locale) => localStorage.setItem("ai4s.locale", locale), chinese ? "zh-Hans" : "en");
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/skills`);
        await page.getByRole("heading", { name: "publication-figures", exact: true }).waitFor();
        await page.getByRole("heading", { name: "workspace-fixture", exact: true }).waitFor();
        const response = await context.request.get(`${origin}/skill?directory=${encodeURIComponent(workspace)}`);
        expect(response.status()).toBe(200);
        const skills = await response.json();
        expect(skills.find((skill) => skill.name === "workspace-fixture").source).toBe("project");
        expect(skills.find((skill) => skill.name === "publication-figures").source).toBe("builtin");
        expect(skills.some((skill) => skill.name === "pdf")).toBe(true);
        const pinned = await cliRuntime.profileResolver.copyForTurn(await cliRuntime.profileResolver.refresh(runtime), { paths: cliRuntime.userPaths(user.id) });
        expect(await readFile(join(pinned.configDir, "skills", "publication-figures", "SKILL.md"), "utf8")).toContain("Publication Figures");
        await page.getByRole("button", { name: chinese ? "安装技能" : "Install skill", exact: true }).click();
        await page.getByText(chinese ? "技能安装在当前工作区，仅在此工作区内可用。" : "Installed in the current workspace; available only in this workspace.", { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await page.screenshot({ path: resolve(`../../.deploy/verification/skills-${runtime}-${width}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await platform.close();
    await cliRuntime.close();
    await workerManager.close();
    await authStore.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!process.env.OSD_SKILLS_ACCEPTANCE)("cleans Web general settings and recovers failed skill discovery at desktop and phone widths", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const output = resolve("../../.deploy/verification");
  await mkdir(output, { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
        expect(login.status()).toBe(200);
        const page = await context.newPage();
        const errors = [];
        let githubChecks = 0;
        let turns = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.url().includes("api.github.com")) githubChecks++;
          if (request.method() === "POST" && /\/session\/[^/]+\/prompt/.test(request.url())) turns++;
        });
        await page.goto(`${origin}/settings/general`);
        await page.getByText("Stall guard", { exact: true }).waitFor();
        expect(await page.getByText("Workspace", { exact: true }).count()).toBe(0);
        expect(await page.getByText("App updates", { exact: true }).count()).toBe(0);
        await page.screenshot({ path: `${output}/general-clean-${width}.png`, fullPage: true });
        await page.route("**/skill?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"skill discovery unavailable"}' }));
        await page.goto(`${origin}/skills`);
        await page.getByRole("alert").waitFor();
        expect(await page.getByRole("alert").textContent()).toContain("Could not load skills");
        expect(await page.getByText("No skills loaded yet.", { exact: true }).count()).toBe(0);
        await page.unroute("**/skill?**");
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.getByRole("heading", { name: "publication-figures", exact: true }).waitFor();
        expect(await page.getByRole("alert").count()).toBe(0);
        await page.getByRole("button", { name: "Install skill", exact: true }).click();
        await page.getByText("Installed in the current workspace; available only in this workspace.", { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${output}/skills-loaded-${width}.png`, fullPage: true });
        expect(githubChecks).toBe(0);
        expect(turns).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
        await context.close();
      }
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.OSD_LOGOUT_ACCEPTANCE)("signs out through the account menu and revokes the browser session", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  try {
    for (const [width, activation] of [[1280, "pointer"], [390, "touch"], [1280, "keyboard"]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: activation === "touch" });
      try {
        const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
        expect(login.status()).toBe(200);
        const originalSession = (await context.cookies()).find((cookie) => cookie.name === "osd_session");
        expect(originalSession).toBeDefined();
        const page = await context.newPage();
        let logoutRequests = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/auth/logout" && request.method() === "POST") logoutRequests++;
        });
        await page.goto(`${origin}/settings/models`);
        if (width === 390) await page.getByRole("button", { name: "Expand sidebar", exact: true }).tap();
        await page.getByRole("button", { name: "admin account", exact: true }).click();
        const signOut = page.getByRole("menuitem", { name: "Sign out", exact: true });
        if (activation === "keyboard") {
          await signOut.focus();
          await page.keyboard.press("Enter");
        } else if (activation === "touch") {
          await signOut.tap();
        } else {
          await signOut.click();
        }
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 8_000 }).toBe("/login");
        expect(logoutRequests).toBe(1);
        expect((await context.cookies()).some((cookie) => cookie.name === "osd_session")).toBe(false);
        const me = await context.request.get(`${origin}/api/me`, { headers: { accept: "application/json" } });
        expect(me.status()).toBe(401);
        const revoked = await context.request.get(`${origin}/api/me`, { headers: { accept: "application/json", cookie: `${originalSession.name}=${originalSession.value}` } });
        expect(revoked.status()).toBe(401);
        await page.goto(`${origin}/settings/models`);
        expect(new URL(page.url()).pathname).toBe("/login");
      } finally {
        await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}, 60_000);

test.skipIf(!process.env.OSD_MANAGED_AGENTS_ACCEPTANCE)("manages Agent access in the production Web bundle without changing live settings", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const output = resolve("../../.deploy/verification");
  await mkdir(output, { recursive: true });
  try {
    for (const [width, locale, ordinary] of [[1280, "en-US", false], [390, "zh-CN", false], [1280, "en-US", true], [390, "zh-CN", true]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
      const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
      expect(login.status()).toBe(200);
      const before = await (await context.request.get(`${origin}/api/admin/runtime`)).json();
      const runtime = await (await context.request.get(`${origin}/api/runtime`)).json();
      const me = await (await context.request.get(`${origin}/api/me`)).json();
      let access = ordinary ? { claude: false, codex: false } : { ...before.assistantEnabled };
      let failSave = true;
      let saves = 0;
      let turns = 0;
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/admin/runtime", async (route) => {
        if (route.request().method() === "POST") {
          saves++;
          const payload = route.request().postDataJSON();
          expect(Object.keys(payload).sort()).toEqual(["enabled", "runtime"]);
          if (failSave) return route.fulfill({ status: 500, json: { error: "fixture failure" } });
          access = { ...access, [payload.runtime]: payload.enabled };
        }
        await route.fulfill({ json: { ...before, assistantEnabled: access } });
      });
      await page.route("**/api/runtime", (route) => {
        const available = runtime.available.map((item) => ({
          ...item, enabled: item.runtime === "opencode" ? item.enabled : access[item.runtime] && item.enabled,
        }));
        return route.fulfill({ json: { ...runtime, available } });
      });
      if (ordinary) await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, user: { ...me.user, role: "user" } } }));
      await page.route("**/prompt_async**", (route) => { turns++; return route.abort(); });
      await page.goto(`${origin}/settings/models`);
      const chinese = locale === "zh-CN";
      const heading = page.getByRole("heading", { name: chinese ? "Agent 使用管理" : "Agent access management", exact: true });
      if (ordinary) {
        const picker = page.getByRole("button", { name: chinese ? /^AI 助手:/ : /^AI assistant:/ }).last();
        await picker.waitFor();
        expect(await heading.count()).toBe(0);
        expect(await page.getByRole("switch", { name: "Allow Codex" }).count()).toBe(0);
        await picker.click();
        const role = width === 390 ? "button" : "menuitem";
        await page.getByRole(role, { name: "OpenCode", exact: true }).waitFor();
        expect(await page.getByRole(role, { name: "Claude Code", exact: true }).count()).toBe(0);
        expect(await page.getByRole(role, { name: "Codex", exact: true }).count()).toBe(0);
        await page.keyboard.press("Escape");
        access = { ...before.assistantEnabled };
        await page.reload();
        await picker.click();
        for (const id of ["claude", "codex"]) {
          const option = runtime.available.find((item) => item.runtime === id);
          const choice = page.getByRole(role, { name: option.label, exact: true });
          if (access[id] && option.enabled) {
            await choice.waitFor();
            expect(await choice.isEnabled()).toBe(true);
          } else {
            expect(await choice.count()).toBe(0);
          }
        }
        await page.keyboard.press("Escape");
        expect(saves).toBe(0);
      } else {
        await heading.waitFor();
        const toggle = page.getByRole("switch", { name: chinese ? "允许使用 Codex" : "Allow Codex", exact: true });
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        const initial = access.codex;
        expect(await toggle.getAttribute("aria-checked")).toBe(String(initial));
        await toggle.click();
        await page.getByRole("alert").filter({ hasText: chinese ? "无法保存 Codex" : "Could not save Codex" }).waitFor();
        expect(await toggle.getAttribute("aria-checked")).toBe(String(initial));
        failSave = false;
        await toggle.click();
        await page.getByText(chinese ? "已保存 Codex。" : "Codex saved.", { exact: true }).waitFor();
        expect(await toggle.getAttribute("aria-checked")).toBe(String(!initial));
        const picker = page.getByRole("button", { name: chinese ? /^AI 助手:/ : /^AI assistant:/ }).last();
        await picker.click();
        const choice = page.getByRole(width === 390 ? "button" : "menuitem", { name: "Codex", exact: true });
        await page.getByRole(width === 390 ? "button" : "menuitem", { name: "OpenCode", exact: true }).waitFor();
        const effective = !initial && runtime.available.find((item) => item.runtime === "codex").enabled;
        if (effective) {
          await choice.waitFor();
          expect(await choice.isEnabled()).toBe(true);
        } else {
          await expect.poll(() => choice.count(), { timeout: 5_000 }).toBe(0);
        }
        await page.keyboard.press("Escape");
        await page.reload();
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        expect(await toggle.getAttribute("aria-checked")).toBe(String(!initial));
        expect(saves).toBe(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      expect(turns).toBe(0);
      await page.screenshot({ path: `${output}/managed-agents-${ordinary ? "user" : "admin"}-${width}.png`, fullPage: true });
      const after = await (await context.request.get(`${origin}/api/admin/runtime`)).json();
      expect(after.assistantEnabled).toEqual(before.assistantEnabled);
      await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
      await context.close();
    }
  } finally { await browser.close(); }
}, 120000);

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

test.skipIf(!process.env.OSD_STALE_SESSION_ACCEPTANCE)("restores unfinished sessions according to live activity in the production Web bundle", async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const origin = process.env.OSD_WEB_ORIGIN || "http://127.0.0.1:4790";
  const password = process.env.OSD_WEB_PASSWORD || execFileSync("sudo", ["-n", "sed", "-n", "s/^PLATFORM_ADMIN_PASSWORD=//p", "/etc/osd-platform.env"], { encoding: "utf8" }).trim();
  const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: true });
  const id = "ses_acceptance_stale";
  const created = Date.parse("2026-09-28T13:24:38Z");
  const history = [
    { info: { id: "msg_acceptance_user", role: "user", time: { created } }, parts: [{ type: "text", text: "Analyze the demo data" }] },
    { info: { id: "msg_acceptance_assistant", role: "assistant", agent: "build", modelID: "big-pickle", providerID: "opencode", time: { created: created + 1 } }, parts: [
      { type: "text", text: "Checking the analysis environment" },
      { type: "tool", callID: "stale-call", tool: "bash", state: { status: "running", input: { command: "python analysis.py" }, time: { start: created + 2 } } },
    ] },
  ];
  const output = resolve("../../.deploy/verification");
  await mkdir(output, { recursive: true });
  try {
    for (const [width, busy] of [[1280, false], [390, false], [1280, true]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      const login = await context.request.post(`${origin}/auth/login`, { headers: { accept: "application/json" }, data: { username: "admin", password } });
      expect(login.status()).toBe(200);
      const { user } = await login.json();
      const directory = resolve(`../../.deploy/platform-data/workers/instances/user-${user.id}/workspace`);
      const page = await context.newPage();
      const errors = [];
      let turns = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/experimental/session?**", (route) => route.fulfill({ json: [{ id, title: "Interrupted analysis acceptance", directory, time: { created, updated: created } }] }));
      await page.route(`**/session/${id}/message`, (route) => route.fulfill({ json: history }));
      await page.route("**/session/status**", (route) => route.fulfill({ json: busy ? { [id]: { type: "busy" } } : {} }));
      await page.route("**/session/*/prompt_async", (route) => { turns++; return route.abort(); });
      await page.goto(`${origin}/live/${id}`);
      await page.getByText("Checking the analysis environment", { exact: true }).waitFor();
      const locked = busy || !!process.env.OSD_STALE_EXPECT_LOCKED;
      await expect.poll(async () => page.getByRole("button", { name: "Stop", exact: true }).count()).toBe(locked ? 1 : 0);
      if (!locked) {
        const input = page.locator("textarea").last();
        await input.fill("Continue the analysis");
        await expect.poll(async () => page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      expect(turns).toBe(0);
      await page.screenshot({ path: `${output}/stale-session-${busy ? "busy" : "idle"}-${width}${process.env.OSD_STALE_EXPECT_LOCKED ? "-before" : ""}.png` });
      await context.request.post(`${origin}/auth/logout`, { headers: { accept: "application/json" } });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}, 90_000);
