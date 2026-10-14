import { parseAnalyticsFilter } from './agent-analytics-contract.mjs';
export function createAnalyticsRoutes({ store, authStore }) {
    return { async handle(request, response, { url }) {
            const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); response.end(JSON.stringify(body)); };
            if (request.method !== 'GET' || request.headers['content-length'] && request.headers['content-length'] !== '0') {
                send(405, { code: 'method_not_allowed' });
                return;
            }
            const suffix = url.pathname.slice('/api/admin/agent-analytics'.length);
            const operations = { '/overview': 'overview', '/runs': 'runs', '/capabilities': 'capabilities', '/interventions': 'interventions', '/filter-options': 'filter-options' };
            const match = suffix.match(/^\/runs\/([a-f0-9]{64})$/), operation = match ? 'run' : operations[suffix];
            if (!operation) {
                send(404, { code: 'not_found' });
                return;
            }
            try {
                const common = ['window', 'to', 'accountId', 'runType', 'category'];
                const allowed = new Set(operation === 'filter-options' ? [] : operation === 'run' ? ['cursor', 'limit'] : operation === 'runs' ? [...common, 'outcome', 'q', 'cursor', 'limit'] : operation === 'interventions' ? [...common, 'cursor', 'limit'] : operation === 'capabilities' ? [...common, 'kind'] : common);
                for (const key of url.searchParams.keys())
                    if (!allowed.has(key))
                        throw Error('invalid_filter');
                const filter = parseAnalyticsFilter(url.searchParams);
                if (match)
                    filter.runId = match[1];
                const c = new AbortController();
                response.once('close', () => { if (!response.writableEnded)
                    c.abort(); });
                const result = await store.read(operation, filter, { signal: c.signal });
                if (operation === 'filter-options') {
                    const users = await authStore.listUsers(), labels = new Map(users.map(u => [u.id, u.username]));
                    result.data.accounts = result.data.accounts.map(a => ({ id: a.id, label: labels.get(a.id) ?? `Archived ${a.id.slice(0, 8)}` }));
                }
                send(200, result);
            }
            catch (e) {
                const code = ['invalid_filter', 'invalid_cursor', 'not_found'].includes(e.message) ? e.message : 'analytics_unavailable';
                send(code === 'not_found' ? 404 : code.startsWith('invalid') ? 400 : 503, { code });
            }
        } };
}
