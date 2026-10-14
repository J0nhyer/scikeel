export function completionCounts(runs) {
    const counts = { completed: 0, failed: 0, cancelled: 0, unknown: 0, running:0,paused:0,waiting_input:0 };
    for (const r of runs)
        if (Object.hasOwn(counts, r.outcome))
            counts[r.outcome]++;
        else
            counts.unknown++;
    const denominator = counts.completed + counts.failed + counts.cancelled;
    return { ...counts,active:counts.running+counts.paused+counts.waiting_input, denominator, rate: denominator ? counts.completed / denominator : null };
}
export function median(values){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;}
export function unionDuration(intervals, start, end) {
    if (![start, end].every(x => typeof x === 'number' && Number.isFinite(x)) || end < start || intervals.some(([a, b]) => typeof a !== 'number' || typeof b !== 'number' || b < a))
        return null;
    const spans = intervals.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let total = 0, current = null;
    for (const span of spans) {
        if (!current)
            current = [...span];
        else if (span[0] <= current[1])
            current[1] = Math.max(span[1], current[1]);
        else {
            total += current[1] - current[0];
            current = [...span];
        }
    }
    return total + (current ? current[1] - current[0] : 0);
}
export function mergeFact(old, next) {
    if (!old)
        return next;
    if(next.parentRunId&&!old.parentRunId)old={...old,parentRunId:next.parentRunId};
    if (old.sourceVersion !== null && next.sourceVersion !== null && next.sourceVersion < old.sourceVersion)
        return old;
    const terminal = x => ['completed', 'failed', 'cancelled', 'approved', 'rejected', 'answered'].includes(x);
    if(old.kind==='run'&&old.outcome==='cancelled'&&old.code==='takeover')return old;
    const newer = next.sourceVersion !== null && (old.sourceVersion === null || next.sourceVersion > old.sourceVersion);
    if (old.code === 'conflicting_update' && !newer)
        return old;
    if (!newer && terminal(old.outcome) && terminal(next.outcome) &&
        (old.outcome !== next.outcome || old.kind === 'usage' && JSON.stringify(old.usage) !== JSON.stringify(next.usage))) {
        return { ...old, outcome: 'unknown', code: 'conflicting_update', usage: old.kind === 'usage' ? null : old.usage };
    }
    if (old.code === 'server_restart' && !terminal(next.outcome))
        return old;
    if (terminal(old.outcome) && !terminal(next.outcome)&&!newer)
        return old;
    return { ...next,parentRunId:old.parentRunId??next.parentRunId, startedAt: old.startedAt ?? next.startedAt, endedAt: next.endedAt ?? old.endedAt };
}

export function capabilityRows(events,kind){
    const grouped=new Map();
    for(const e of events){
        const name=kind==='models'?`${e.providerId??'Unknown provider'} / ${e.modelId??'Unknown model'}`:kind==='skills'?(e.skillId??'Unknown skill'):kind==='subagents'?'Linked child sessions':e.capabilityId;
        const row=grouped.get(name)??{name,calls:0,completed:0,failed:0,retries:null,timings:[]};
        row.calls++;if(e.outcome==='completed')row.completed++;if(e.outcome==='failed')row.failed++;
        if(e.retryCount!==null)row.retries=(row.retries??0)+e.retryCount;
        if(e.firstByteMs!==null)row.timings.push(e.firstByteMs);
        grouped.set(name,row);
    }
    return {rows:[...grouped.values()].sort((a,b)=>b.calls-a.calls).slice(0,50).map(({timings,...row})=>({...row,firstByteMs:median(timings)})),truncated:grouped.size>50};
}
