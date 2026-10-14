// @vitest-environment node
import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthStore } from '../../../../services/platform/src/auth-store.mjs';
import { PlatformServer } from '../../../../services/platform/src/platform-server.mjs';
import { createAnalyticsStore } from '../../../../services/platform/src/agent-analytics-store.mjs';
import { createAnalyticsRoutes } from '../../../../services/platform/src/agent-analytics-routes.mjs';
import { sanitizeFact, runId } from '../../../../services/platform/src/agent-analytics-contract.mjs';
test.skipIf(!process.env.OSD_AGENT_ANALYTICS_ACCEPTANCE)('protected analytics uses the candidate bundle and stays passive across themes and phone widths', async () => {
    const { chromium } = createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
    const dir = await mkdtemp(join(tmpdir(), 'scikeel-analytics-browser-'));
    const authStore = new AuthStore({ filePath: join(dir, 'auth.json'), bootstrapAdmin: { username: 'fixture', password: 'fixture-password' } });
    await authStore.init();
    const admin = (await authStore.listUsers())[0];
    const store = createAnalyticsStore({ path: join(dir, 'analytics.sqlite') });
    const scope = { accountId: admin.id, runtime: 'opencode', instanceId: 'fixture', generation: 1 }, id = runId(scope, 's', '1'), now = Date.now() - 1000;
    for (const fact of [{ kind: 'run', entityId: 'r', runId: id, runType: 'research', startedAt: now, endedAt: now + 100, outcome: 'completed', delivery: { outputs: 'passed', evidence: 'passed', inputsPreserved: 'passed' } },
        { kind: 'tool', entityId: 't', runId: id, capabilityId: 'read', startedAt: now, endedAt: now + 20, outcome: 'completed', output: 'CANARY_PRIVATE' },
        { kind: 'usage', entityId: 'm', runId: id, startedAt: now, usage: { input: 100, output: 20 }, outcome: 'completed' }])
        store.offer(sanitizeFact(scope, fact));
    await store.flush();
    let starts = 0;
    const platform = new PlatformServer({ authStore, workerManager: { rootDir: join(dir, 'workers'), init: async () => { }, ensureWorker: () => { starts++; throw Error('worker forbidden'); } },
        webRoot: process.env.OSD_WEB_CANDIDATE || resolve('dist'), analyticsRoutes: createAnalyticsRoutes({ store, authStore }) });
    const address = await platform.listen(), origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: process.env.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const screenshots = resolve('../../.deploy/verification/agent-analytics');
    await mkdir(screenshots, { recursive: true });
    try {
        const loginContext = await browser.newContext();
        await loginContext.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
        const loginPage = await loginContext.newPage();
        await loginPage.goto(`${origin}/admin/agent-analytics?view=runs`);
        expect(new URL(loginPage.url()).pathname).toBe('/login');
        await loginPage.locator('#username').fill('fixture');
        await loginPage.locator('#password').fill('fixture-password');
        await loginPage.locator('button[type="submit"]').click();
        await loginPage.getByRole('tab', { name: 'Task runs', exact: true }).waitFor();
        expect(new URL(loginPage.url()).pathname).toBe('/admin/agent-analytics');
        expect(new URL(loginPage.url()).searchParams.get('view')).toBe('runs');
        expect(starts).toBe(0);
        await loginContext.close();
        const ordinary = await authStore.createUser({ username: 'ordinary', password: 'fixture-password', role: 'user' });
        const ordinarySession = await authStore.createSession(ordinary.id);
        for (const [token, status] of [[null, 401], [ordinarySession.token, 403]]) {
            const response = await fetch(`${origin}/api/admin/agent-analytics/overview`, { headers: token ? { cookie: `osd_session=${token}` } : {} });
            expect(response.status).toBe(status);
            expect(response.headers.get('cache-control')).toContain('no-store');
        }
        const deniedPage = await fetch(`${origin}/admin/agent-analytics`, { headers: { cookie: `osd_session=${ordinarySession.token}` } });
        expect(deniedPage.status).toBe(403);
        const session = await authStore.createSession(admin.id);
        for (const theme of ['light', 'warm', 'dark'])
            for (const width of [1440, 390, 320]) {
                const context = await browser.newContext({ viewport: { width, height: 900 } });
                await context.addCookies([{ name: 'osd_session', value: session.token, url: origin }]);
                await context.addInitScript(({ theme }) => { localStorage.setItem('ai4s.locale', 'en'); localStorage.setItem('ai4s.theme.v2', theme); }, { theme });
                const page = await context.newPage(), requests = [], errors = [];
                page.on('request', req => requests.push(new URL(req.url()).pathname));
                page.on('pageerror', e => errors.push(e.message));
                await page.goto(`${origin}/admin/agent-analytics`);
                await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor();
                await page.getByText('Execution completion', { exact: true }).waitFor();
                await page.screenshot({ path: join(screenshots, `${theme}-${width}-overview.png`) });
                expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/Inter/i);
                expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
                for (const view of ['Task runs', 'Tools & models', 'Human interventions']) {
                    await page.getByRole('tab', { name: view, exact: true }).click();
                    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                }
                await page.getByRole('tab', { name: 'Tools & models', exact: true }).click();
                for (const tab of ['Tools', 'Skills', 'Models', 'Subagents'])
                    await page.getByRole('tab', { name: tab, exact: true }).click();
                await page.getByRole('tab', { name: 'Task runs', exact: true }).click();
                await page.getByRole('button', { name: /Research execution/ }).click();
                await page.getByRole('dialog').waitFor();
                await page.screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                expect(await page.locator('body').textContent()).not.toContain('CANARY_PRIVATE');
                await page.keyboard.press('Escape');
                expect(await page.getByRole('dialog').count()).toBe(0);
                expect(requests.filter(p => p === '/event' || p.startsWith('/session') || p === '/api/runtime' || p.startsWith('/v1/') || p === '/config/providers')).toEqual([]);
                expect(errors).toEqual([]);
                await context.close();
            }
        expect(starts).toBe(0);
        const chineseContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await chineseContext.addCookies([{ name: 'osd_session', value: session.token, url: origin }]);
        await chineseContext.addInitScript(() => localStorage.setItem('ai4s.locale', 'zh-Hans'));
        const chinesePage = await chineseContext.newPage();
        await chinesePage.goto(`${origin}/admin/agent-analytics`);
        await chinesePage.getByRole('heading', { name: '智能体分析', exact: true }).waitFor();
        await chinesePage.getByText('执行完成率', { exact: true }).waitFor();
        for (const name of ['概览', '任务执行', '工具与模型', '人工介入']) {
            await chinesePage.getByRole('tab', { name, exact: true }).click();
            expect(await chinesePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await chinesePage.getByRole('tab', { name: '任务执行', exact: true }).click();
        await chinesePage.getByRole('button', { name: /研究任务/ }).click();
        await chinesePage.getByRole('dialog').waitFor();
        await chinesePage.getByText('交付检查', { exact: true }).waitFor();
        await chinesePage.screenshot({ path: join(screenshots, 'zh-Hans-1440.png') });
        expect(await chinesePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await chineseContext.close();
        const context = await browser.newContext();
        await context.addCookies([{ name: 'osd_session', value: session.token, url: origin }]);
        const page = await context.newPage();
        await page.goto(`${origin}/admin/agent-analytics`);
        await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor();
        await authStore.revokeSession(session.token);
        await page.reload();
        expect(await page.getByRole('tab', { name: 'Overview', exact: true }).count()).toBe(0);
        await context.close();
        const revoked = await fetch(`${origin}/api/admin/agent-analytics/runs`, { headers: { cookie: `osd_session=${session.token}` } });
        expect(revoked.status).toBe(401);
    }
    finally {
        await browser.close();
        await platform.close();
        await store.close();
        await authStore.close();
        await rm(dir, { recursive: true, force: true });
    }
}, 90000);
