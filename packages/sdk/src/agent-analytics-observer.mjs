const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=256;
export function metadataFacts(event, now = Date.now()) {
    const p = event?.properties ?? {}, kind = event?.type;
    if (kind === 'message.updated') {
        const i = p.info;
        if (!identifier(i?.id) || !identifier(i.sessionID))
            return [];
        if (i.role === 'user')
            return [{ kind: 'accepted_turn', entityId: i.id, sessionId: i.sessionID, executionId: i.id, startedAt: number(i.time?.created) ?? now }];
        if (i.role !== 'assistant'||!identifier(i.parentID))
            return [];
        const facts = [{ kind: 'message_link', entityId: i.id, sessionId: i.sessionID, executionId: i.parentID }];
        if (i.providerID||i.modelID||i.tokens)
            facts.push({ kind: 'usage', entityId: i.id, sessionId: i.sessionID, messageId: i.id, executionId: i.parentID,
                startedAt: number(i.time?.created), endedAt: number(i.time?.completed), sourceVersion: number(i.time?.completed),
                providerId: i.providerID, modelId: i.modelID, usage:i.tokens? { input: number(i.tokens.input), output: number(i.tokens.output), reasoning: number(i.tokens.reasoning), cacheRead: number(i.tokens.cache?.read), cacheWrite: number(i.tokens.cache?.write) }:null,
                outcome: i.time?.completed ? i.error ? 'failed' : 'completed' : 'running' });
        if (i.time?.completed && (['stop','cancelled'].includes(i.finish) || i.error))
            facts.push({ kind: 'turn_end', entityId: i.id, sessionId: i.sessionID, executionId: i.parentID,
                outcome: i.finish==='cancelled'?'cancelled':i.error?'failed':'completed',code:i.error?'runtime_error':null, endedAt: i.time.completed });
        return facts;
    }
    if (kind === 'message.part.updated' && p.part?.type === 'tool') {
        const t = p.part, s = t.state ?? {};
        if (!identifier(t.callID)||!identifier(t.sessionID)||!identifier(t.messageID))
            return [];
        const base = { kind: 'tool', entityId: `${t.messageID}:${t.callID}`, messageId: t.messageID, sessionId: t.sessionID, capabilityId: t.tool,
            outcome: ['pending', 'running', 'completed'].includes(s.status) ? s.status : s.status === 'error' ? 'failed' : 'unknown', startedAt: number(s.time?.start), endedAt: number(s.time?.end) };
        const facts = [base];
        if (t.tool === 'task' && identifier(s.metadata?.sessionId))
            facts.push({ ...base, kind: 'subagent', childSessionId: s.metadata.sessionId });
        if (t.tool === 'skill' && s.status === 'completed' && identifier(s.input?.name))
            facts.push({ ...base, kind: 'skill', skillId: s.input.name });
        return facts;
    }
    if (/^(permission|question)(\.v2)?\.(asked|replied|rejected)$/.test(kind ?? '')) {
        const asked = kind.endsWith('asked'), question = kind.startsWith('question');
        if(!identifier(p.requestID??p.id)||asked&&!identifier(p.sessionID))return [];
        return [{ kind: 'intervention', entityId: p.requestID ?? p.id, sessionId: p.sessionID, code: question ? 'clarification' : 'approval',
                messageId: p.tool?.messageID, startedAt: asked ? now : null, endedAt: asked ? null : now,
                outcome: asked ? 'pending' : kind.endsWith('rejected') ? 'rejected' : question ? 'answered' : p.reply === 'reject' ? 'rejected' : ['once', 'always'].includes(p.reply) ? 'approved' : 'unknown' }];
    }
    if (kind === 'session.error'&&identifier(p.sessionID))
        return [{ kind: 'runtime_error', entityId: p.sessionID, sessionId: p.sessionID, code: 'runtime_error', endedAt: now }];
    return [];
}
export function createOpenCodeMetadataObserver({ baseUrl, token, fetchImpl = fetch, onFact, onGap, onConnected = () => { } }) {
    let closed = false, controller, timer, attempt = 0;
    async function connect() {
        if (closed)
            return;
        controller = new AbortController();
        const opening = setTimeout(() => controller.abort(), 15000);
        opening.unref?.();
        try {
            const res = await fetchImpl(new URL('/event', baseUrl), { headers: { authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`, accept: 'text/event-stream' }, signal: controller.signal });
            if (!res.ok || !res.body)
                throw new Error('observer_unavailable');
            clearTimeout(opening);
            onConnected();
            attempt = 0;
            const decoder = new TextDecoder();
            let buffer = '';
            let dropping = false;
            for await (const chunk of res.body) {
                if (closed)
                    break;
                for(let offset=0;offset<chunk.length;offset+=16384){
                buffer = (buffer + decoder.decode(chunk.subarray(offset,offset+16384), { stream: true })).replace(/\r\n/g, '\n');
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    if (dropping || frame.length > 262144) {
                        dropping = false;
                        onGap('observer_disconnected');
                        continue;
                    }
                    const text = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                    if (!text)
                        continue;
                    try {
                        const raw = JSON.parse(text);
                        const event = raw.payload ?? raw;
                        for (const fact of metadataFacts(event))
                            onFact(fact);
                    }
                    catch {
                        onGap('observer_disconnected');
                    }
                }
                if (buffer.length > 262144) {
                    buffer = '';
                    dropping = true;
                    onGap('observer_disconnected');
                }
                }
            }
        }
        catch {
            if (!closed)
                onGap('observer_disconnected');
        }
        finally {
            clearTimeout(opening);
            if (!closed) {
                onGap('observer_disconnected');
                timer = setTimeout(() => void connect(), Math.min(15000, 1000 * 2 ** attempt++));
                timer.unref?.();
            }
        }
    }
    return { start: () => { void connect(); }, close: () => { closed = true; clearTimeout(timer); controller?.abort(); } };
}
