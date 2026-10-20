import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commonStore } from "../../../scripts/dev/web-release-source.mjs";
import { SandboxClient } from "../src/sandbox-client.mjs";

test("real account capacity recovery preserves work, isolates background reconnects and restores project files", {
  skip: process.env.SCIKEEL_CAPACITY_LIVE_ACCEPTANCE !== "1", timeout: 600000,
}, async () => {
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const store = commonStore(root);
  const pointer = JSON.parse(await readFile(join(store, "web-releases/current.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(store, "web-releases", pointer.id, "manifest.json"), "utf8"));
  assert.equal(process.env.SCIKEEL_CAPACITY_RELEASE, pointer.id, "An explicit published release must be selected");
  assert.equal(manifest.deployment?.liveAssistant?.status, "passed");
  const target = manifest.assistantTarget;
  assert.equal(target.runtime, "codex");
  const pid = execFileSync("systemctl", ["show", "osd-platform.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
  assert.match(pid, /^[1-9]\d*$/);
  const environment = execFileSync("sudo", ["-n", "cat", `/proc/${pid}/environ`], { encoding: "utf8" });
  const env = Object.fromEntries(environment.split("\0").filter(Boolean).map(item => {
    const index = item.indexOf("="); return [item.slice(0, index), item.slice(index + 1)];
  }));
  const origin = `http://127.0.0.1:${manifest.deployment.production.port}`;
  const evidenceDir = join(root, ".deploy/verification", `workspace-capacity-${Date.now()}`);
  await mkdir(evidenceDir, { recursive: true });
  const evidence = { release: pointer.id, cases: [], screenshots: [], correlations: [] };
  const accounts = []; const contexts = new Set(); let browser; let heartbeat; let session; let firewall; let primaryFailure;
  const startedAt = new Date().toISOString();
  const request = (cookie, path, { body, headers, method = body === undefined ? "GET" : "POST" } = {}) => fetch(origin + path, {
    method, headers: { accept: "application/json", "content-type": "application/json", origin, cookie, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000),
  });
  const json = async (cookie, path, options) => {
    const response = await request(cookie, path, options);
    assert(response.ok, `Live request failed: ${path.split("?")[0]} HTTP ${response.status}`);
    const text = await response.text(); return text ? JSON.parse(text) : null;
  };
  const login = async (username, password) => {
    const response = await request("", "/auth/login", { body: { username, password } });
    assert(response.ok, "Live login failed");
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  };
  const admin = await login(env.PLATFORM_ADMIN_USERNAME || "admin", env.PLATFORM_ADMIN_PASSWORD);
  const until = async (inspect, timeout = 120000) => {
    const deadline = Date.now() + timeout;
    do { const result = await inspect(); if (result) return result; await delay(500); } while (Date.now() < deadline);
    throw new Error("Live capacity verification timed out");
  };
  const initialize = async account => {
    await json(account.cookie, "/v1/whoami"); account.runtime = await json(account.cookie, "/api/runtime");
    assert.equal(account.runtime.runtime, "codex");
    account.headers = { "x-scikeel-runtime-generation": String(account.runtime.context.generation),
      "x-scikeel-assistant-revision": String(account.runtime.policyRevision), "x-scikeel-manual-approval": "1" };
  };
  const scoped = (account, path, options = {}) => json(account.cookie, path, { ...options, headers: { ...account.headers, ...options.headers } });
  const pageFor = async (account, locale, preparing = false) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.add(context);
    await context.addCookies(account.cookie.split("; ").map(pair => {
      const index = pair.indexOf("="); return { name: pair.slice(0, index), value: pair.slice(index + 1), url: origin, httpOnly: true };
    }));
    await context.addInitScript(({ locale, preparing }) => {
      localStorage.setItem("ai4s.locale", locale);
      if (preparing) sessionStorage.setItem("scikeel.login.pending", JSON.stringify({ locale, startedAt: Date.now() }));
    }, { locale, preparing });
    const page = await context.newPage(); await page.goto(origin + "/"); return { context, page };
  };
  const screenshot = async (page, name) => {
    await page.evaluate(async () => {
      const animations = document.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(animations.map(animation => animation.finished.catch(error => { if (error.name !== "AbortError") throw error; })));
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Viewport overflow");
    assert.deepEqual(await page.evaluate(() => {
      const failures = [];
      const inspect = root => {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) inspect(element.shadowRoot);
          if (!element.matches("button, input, h1, [role='alert'], .status")) continue;
          if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
          const bounds = element.getBoundingClientRect();
          if (bounds.right <= 1 || bounds.left >= innerWidth || bounds.bottom <= 0 || bounds.top >= innerHeight) continue;
          if (bounds.left < -1 || bounds.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1)
            failures.push({ tag: element.tagName, text: element.textContent?.trim().slice(0, 80) });
        }
      };
      inspect(document); return failures;
    }), [], "Visible controls fit both document and login shadow root");
    const file = `${name}.png`; await page.screenshot({ path: join(evidenceDir, file), fullPage: true }); evidence.screenshots.push(file);
  };
  try {
    for (const suffix of ["a", "b"]) {
      const username = `capacity-${suffix}-${randomBytes(5).toString("hex")}`, password = randomBytes(24).toString("hex");
      const { user } = await json(admin, "/api/admin/users", { body: { username, password, role: "user" } });
      const account = { ...user, password }; accounts.push(account); account.cookie = await login(username, password);
    }
    const [a, b] = accounts;
    const settings = JSON.parse(await readFile(join(store, "web-release-settings.json"), "utf8"));
    const { chromium } = createRequire(import.meta.url)(settings.OSD_PLAYWRIGHT_PATH);
    browser = await chromium.launch({ executablePath: settings.OSD_CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    await initialize(a);
    const old = await pageFor(a, "en"); await old.page.getByRole("button", { name: /^Model:/ }).first().waitFor({ timeout: 60000 });
    const next = await pageFor(b, "en", true);
    await next.page.getByRole("button", { name: /^Model:/ }).first().waitFor({ timeout: 90000 }); await initialize(b);
    const generation = b.runtime.context.generation;
    await delay(12000);
    assert.equal((await scoped(b, "/api/runtime")).context.generation, generation, "Open old page cannot restart the winner");
    assert.equal((await request(a.cookie, "/session/status", { headers: a.headers })).status, 503);
    await screenshot(next.page, "idle-switch-ready-en-1280"); evidence.cases.push("idle_switch_with_old_page_open");
    await old.context.close(); contexts.delete(old.context); await next.context.close(); contexts.delete(next.context);

    await initialize(a);
    session = await scoped(a, "/session", { body: { title: "Workspace capacity protected execution" } });
    let state = (await scoped(a, `/api/collaboration/${session.id}`)).state;
    if (state.mode !== "autonomous") state = (await scoped(a, `/api/collaboration/${session.id}`, { body: { action: "mode", mode: "autonomous", revision: state.revision } })).state;
    await scoped(a, `/session/${session.id}/prompt_async`, { body: {
      model: { providerID: "codex", modelID: target.model }, collaborationRevision: state.revision,
      parts: [{ type: "text", text: 'Use request_user_input to ask exactly "Capacity acceptance" with options "Continue" and "Stop". Wait for the real answer. After receiving Continue, reply exactly CAPACITY_WORK_PRESERVED. Do not execute other tasks.' }],
    }, headers: { "x-scikeel-request-id": "capacity-" + randomUUID() } });
    const question = await until(async () => (await scoped(a, "/question")).find(value => value.sessionID === session.id));
    let heartbeatFailure;
    heartbeat = setInterval(() => { void scoped(a, `/api/collaboration/${session.id}`, { body: { action: "heartbeat", pageId: "capacity-acceptance" } }).catch(error => { heartbeatFailure = error; }); }, 10000);
    const waitingPages = [];
    for (const locale of ["en", "zh-Hans"]) {
      const identity = locale === "en" ? b : { ...b, cookie: await login(b.username, b.password) };
      const waiting = await pageFor(identity, locale, true); waitingPages.push(waiting);
      waiting.requests = [];
      waiting.page.on("request", value => { if (new URL(value.url()).pathname === "/v1/whoami") waiting.requests.push(Date.now()); });
      const label = locale === "en" ? "Waiting for workspace" : "正在等待工作区";
      await until(async () => (await waiting.page.evaluate(() => document.getElementById("scikeel-login-preparation")?.shadowRoot?.textContent ?? "")).includes(label));
      for (const width of [1280, 390, 320]) {
        await waiting.page.setViewportSize({ width, height: 900 }); await screenshot(waiting.page, `waiting-${locale}-${width}`);
      }
    }
    const refusal = await request(b.cookie, "/v1/whoami"); assert.equal(refusal.status, 503);
    const failure = await refusal.json(); assert.equal(failure.code, "workspace_capacity_unavailable");
    assert.equal(failure.retryAfterMs, 5000); assert.equal(refusal.headers.get("retry-after"), "5"); evidence.correlations.push(failure.correlationId);
    assert.equal((await scoped(a, "/api/runtime")).context.generation, a.runtime.context.generation);
    await delay(26000);
    assert(waitingPages[0].requests.length >= 5, "Capacity waiting exceeds the generic retry count");
    assert(waitingPages[0].requests.slice(1).every((value, index) => value - waitingPages[0].requests[index] >= 4500), "Capacity attempts respect their delay");
    evidence.retryIntervalsMs = waitingPages[0].requests.slice(1).map((value, index) => value - waitingPages[0].requests[index]);
    const deadlinePage = waitingPages[0].page;
    await deadlinePage.getByRole("button", { name: "Retry connection", exact: true }).waitFor({ state: "visible", timeout: 100000 });
    for (const [index, locale] of ["en", "zh-Hans"].entries()) {
      const page = waitingPages[index].page;
      await page.getByRole("button", { name: locale === "en" ? "Retry connection" : "重试连接", exact: true }).waitFor({ timeout: 10000 });
      for (const width of [1280, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await screenshot(page, `deadline-${locale}-${width}`); }
    }
    assert.equal(heartbeatFailure, undefined);
    assert((await scoped(a, "/question")).some(value => value.id === question.id), "Protected question survives the entire deadline");
    evidence.cases.push("active_execution_preserved_for_capacity_deadline");
    const logoutPage = waitingPages[1].page;
    await logoutPage.getByRole("button", { name: "重试连接", exact: true }).click(); await delay(1000);
    await logoutPage.getByRole("button", { name: "退出登录", exact: true }).click(); await logoutPage.waitForURL(/\/login/);
    const requestsAfterLogout = waitingPages[1].requests.length; await delay(6000);
    assert.equal(waitingPages[1].requests.length, requestsAfterLogout); evidence.cases.push("logout_cancels_capacity_retry");
    await waitingPages[1].context.close(); contexts.delete(waitingPages[1].context);
    await deadlinePage.getByRole("button", { name: "Retry connection", exact: true }).click();
    await scoped(a, `/question/${encodeURIComponent(question.id)}/reply`, { body: { answers: question.questions.map(() => ["Continue"]) } });
    clearInterval(heartbeat); heartbeat = undefined;
    await deadlinePage.getByRole("button", { name: /^Model:/ }).first().waitFor({ timeout: 90000 }); await initialize(b);
    await screenshot(deadlinePage, "busy-recovery-ready-en-320"); evidence.cases.push("capacity_wait_recovers_after_real_execution");
    await waitingPages[0].context.close(); contexts.delete(waitingPages[0].context);

    await initialize(a);
    const launcher = new SandboxClient({ socketPath: env.PLATFORM_SANDBOX_SOCKET });
    const before = await launcher.inspect({ instanceId: a.runtime.context.instanceId });
    const endpoint = new URL(before.endpoint);
    firewall = ["OUTPUT", "-d", endpoint.hostname, "-p", "tcp", "--dport", endpoint.port, "-m", "comment", "--comment", "capacity-" + randomUUID(), "-j", "REJECT"];
    execFileSync("sudo", ["-n", "iptables", "-I", ...firewall]);
    try {
      const unavailable = await request(b.cookie, "/v1/whoami"); assert.equal(unavailable.status, 503);
      const report = await unavailable.json(); assert.equal(report.code, "workspace_capacity_unavailable"); evidence.correlations.push(report.correlationId);
      const after = await launcher.inspect({ instanceId: a.runtime.context.instanceId });
      assert.equal(after.generation, before.generation); assert.equal(after.status, "ready");
    } finally { execFileSync("sudo", ["-n", "iptables", "-D", ...firewall]); firewall = undefined; }
    evidence.cases.push("unverified_idle_does_not_stop_the_owner"); await initialize(b);
    const project = await scoped(b, "/v1/projects", { body: { name: "Capacity verification" } });
    await scoped(b, `/api/workspace/projects/${project.id}`, { method: "PATCH", body: { name: "Capacity retained project", operationId: "capacity-" + randomUUID() } });
    const scope = { kind: "project", projectId: project.id }, content = "capacity verification " + randomUUID();
    await scoped(b, "/api/workspace/operations", { body: { scope, operationId: "capacity-" + randomUUID(), operation: { kind: "createFile", path: "capacity.txt", text: content } } });
    const textPath = path => "/api/workspace/text?" + new URLSearchParams({ scope: JSON.stringify(scope), path });
    const written = await scoped(b, textPath("capacity.txt")); assert.equal(written.text, content);
    await scoped(b, "/api/workspace/operations", { body: { scope, operationId: "capacity-" + randomUUID(), operation: { kind: "rename", path: "capacity.txt", destinationPath: "retained.txt", expectedRevision: written.revision } } });
    const current = (await scoped(b, "/api/workspace/projects")).find(value => value.id === project.id);
    await scoped(b, `/api/workspace/projects/${project.id}/trash`, { body: { operationId: "capacity-" + randomUUID(), expectedRevision: current.revision } });
    assert(!(await scoped(b, "/api/workspace/projects")).some(value => value.id === project.id));
    await scoped(b, `/api/workspace/trash/${project.id}/restore`, { body: { operationId: "capacity-" + randomUUID() } });
    for (const locale of ["en", "zh-Hans"]) {
      const ready = await pageFor(b, locale); await ready.page.getByRole("button", { name: /^Model:|^模型/ }).first().waitFor({ timeout: 30000 });
      for (const width of [1280, 390, 320]) { await ready.page.setViewportSize({ width, height: 900 }); await screenshot(ready.page, `ready-${locale}-${width}`); }
      await ready.page.reload(); await until(async () => (await scoped(b, textPath("retained.txt"))).text === content);
      await ready.context.close(); contexts.delete(ready.context);
    }
    assert.equal((await scoped(b, "/api/workspace/projects")).find(value => value.id === project.id).name, "Capacity retained project");
    evidence.cases.push("project_rename_file_rename_trash_restore_reload");
    await initialize(a); assert.equal((await scoped(a, `/session/${session.id}`)).id, session.id);
    assert((await scoped(a, `/session/${session.id}/message`)).some(message => message.info.role === "assistant" && message.info.time?.completed && message.parts?.some(part => part.type === "text" && part.text.includes("CAPACITY_WORK_PRESERVED"))));
    const lines = execFileSync("journalctl", ["-u", "osd-platform.service", "--since", startedAt, "--no-pager", "-o", "cat"], { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 }).split("\n");
    const diagnostics = lines.flatMap(line => { try { const event = JSON.parse(line); return event.type === "workspace.capacity_rejected" ? [event] : []; } catch { return []; } });
    assert(evidence.correlations.every(id => diagnostics.some(event => event.correlationId === id)), "Capacity responses match decision logs");
    assert(diagnostics.some(event => event.reason === "idle_unverified" && evidence.correlations.includes(event.correlationId)));
    evidence.cases.push("decision_log_correlation_and_conversation_identity");
    evidence.status = "passed";
  } catch (error) {
    evidence.failurePages = [];
    for (const context of contexts) for (const page of context.pages()) {
      try {
        evidence.failurePages.push(await page.evaluate(() => ({ path: location.pathname,
          visibleText: document.body.innerText.slice(0, 6000), preparing: document.documentElement.getAttribute("data-scikeel-login-preparing"),
          preparationText: document.getElementById("scikeel-login-preparation")?.shadowRoot?.textContent?.slice(-3000) })));
        await page.screenshot({ path: join(evidenceDir, `failure-${evidence.failurePages.length}.png`), fullPage: true });
      } catch (inspectionError) { evidence.failurePages.push({ inspection: inspectionError.name }); }
    }
    primaryFailure = error; evidence.status = "failed"; throw error;
  } finally {
    clearInterval(heartbeat);
    const cleanupErrors = [];
    const cleanup = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    if (firewall) await cleanup(() => execFileSync("sudo", ["-n", "iptables", "-D", ...firewall]));
    for (const context of contexts) await cleanup(() => context.close());
    await cleanup(() => browser?.close());
    if (session) await cleanup(async () => {
      const account = accounts[0];
      const pending = async () => {
        const value = JSON.parse(await readFile(join(env.PLATFORM_DATA_DIR, "cli-runtime/runtime.json"), "utf8"));
        return Object.values(value.assistantPolicy.executions).some(execution =>
          execution.identity.userId === account.id && execution.identity.conversationId === session.id);
      };
      if (await pending()) {
        await scoped(account, `/session/${session.id}/abort`, { body: {} });
        await until(async () => !await pending(), 30000);
      }
    });
    for (const account of accounts) {
      await cleanup(async () => {
        const disabled = await json(admin, `/api/admin/users/${account.id}/disable`, { body: { disabled: true } });
        assert.equal(disabled.user.id, account.id); assert.equal(disabled.user.disabled, true);
      });
      if (account.cookie) await cleanup(() => json(account.cookie, "/auth/logout", { body: {} }));
    }
    await cleanup(() => json(admin, "/auth/logout", { body: {} }));
    evidence.cleanup = { status: cleanupErrors.length ? "failed" : "passed", failures: cleanupErrors.length };
    await cleanup(() => writeFile(join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n"));
    if (cleanupErrors.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors], "Live capacity cleanup failed");
  }
  console.log(JSON.stringify({ status: evidence.status, release: evidence.release, cases: evidence.cases, evidenceDir }));
});
