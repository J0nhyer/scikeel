import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthStore } from '../src/auth-store.mjs';
import { PlatformServer } from '../src/platform-server.mjs';
import { createAnalyticsRoutes } from '../src/agent-analytics-routes.mjs';
test('admin endpoints authenticate before reads and never start a worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-auth-'));
    const authStore = new AuthStore({ filePath: join(dir, 'auth.json'), bootstrapAdmin: { username: 'admin', password: 'test-password' } });
    await authStore.init();
    const user = await authStore.createUser({ username: 'user', password: 'test-password', role: 'user' });
    const admin = (await authStore.listUsers()).find(u => u.role === 'admin');
    let reads = 0, starts = 0;
    const store = { read: async () => { reads++; return { schema: 1, data: { rows: [] } }; } };
    const platform = new PlatformServer({ authStore,tenantPolicy:{}, workerManager: { rootDir: join(dir, 'workers'), init: async () => { }, ensureWorker: () => { starts++; throw Error('no worker'); } }, analyticsRoutes: createAnalyticsRoutes({ store, authStore }) });
    const a = await platform.listen(), origin = `http://127.0.0.1:${a.port}`;
    try {
        const destination = '/admin/agent-analytics?view=runs&window=30d';
        const navigation = await fetch(`${origin}${destination}`, { redirect: 'manual' });
        assert.equal(navigation.status, 303);
        assert.equal(new URL(navigation.headers.get('location'), origin).searchParams.get('next'), destination);
        for (const [owner, status] of [[null, 401], [user, 403], [admin, 200]]) {
            const session = owner ? await authStore.createSession(owner.id) : null;
            const res = await fetch(`${origin}/api/admin/agent-analytics/runs`, { headers: session ? { cookie: `osd_session=${session.token}` } : {} });
            assert.equal(res.status, status);
            assert.match(res.headers.get('cache-control'), /no-store/);
            if (session)
                await authStore.revokeSession(session.token);
        }
        assert.equal(reads, 1);
        assert.equal(starts, 0);
        const login=await fetch(`${origin}/auth/login`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:new URLSearchParams({username:'admin',password:'test-password',next:'/admin/agent-analytics?view=runs'}),redirect:'manual'});
        assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/admin/agent-analytics?view=runs');
        await new Promise(resolve=>setTimeout(resolve,10));assert.equal(starts,0);
        const session=await authStore.createSession(admin.id),headers={cookie:`osd_session=${session.token}`};
        for(const path of ['/runs?window=7d&window=30d','/overview?cursor=invalid','/filter-options?window=7d','/capabilities?limit=100']){
          assert.equal((await fetch(`${origin}/api/admin/agent-analytics${path}`,{headers})).status,400);
        }
        assert.equal((await fetch(`${origin}/api/admin/agent-analytics/runs`,{method:'POST',headers})).status,405);
        assert.equal(reads,1);
        await authStore.createUser({username:'second-admin',password:'test-password',role:'admin'});
        await authStore.disableUser(admin.id);
        assert.equal((await fetch(`${origin}/api/admin/agent-analytics/runs`,{headers})).status,401);
        assert.equal(reads,1);
    }
    finally {
        await platform.close();
        await authStore.close();
        await rm(dir, { recursive: true, force: true });
    }
});
