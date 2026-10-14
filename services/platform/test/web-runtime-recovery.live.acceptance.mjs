import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commonStore } from '../../../scripts/dev/web-release-source.mjs';

test('production restores five warm reloads and preserves an OpenCode turn until Stop', {
  skip: process.env.SCIKEEL_RECOVERY_LIVE_ACCEPTANCE !== '1', timeout: 180000,
}, async () => {
  const store = commonStore(resolve(fileURLToPath(new URL('../../../', import.meta.url))));
  const pointer = JSON.parse(await readFile(store + '/web-releases/current.json', 'utf8'));
  const manifest = JSON.parse(await readFile(store + '/web-releases/' + pointer.id + '/manifest.json', 'utf8'));
  const verification = manifest.deployment?.liveOpenCode;
  assert.match(verification?.sessionId ?? '', /^ses_[A-Za-z0-9]+$/);
  assert.equal(verification.provider, 'opencode');
  assert(!verification.model.toLowerCase().includes('claude'));
  const pid = execFileSync('systemctl', ['show', 'osd-platform.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
  assert.match(pid, /^[1-9]\d*$/);
  const raw = execFileSync('sudo', ['-n', 'cat', `/proc/${pid}/environ`], { encoding: 'utf8' });
  const env = Object.fromEntries(raw.split('\0').map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; }));
  const origin = `http://127.0.0.1:${manifest.deployment.production.port}`;
  const login = await fetch(origin + '/auth/login', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: env.PLATFORM_ADMIN_USERNAME || 'admin', password: env.PLATFORM_ADMIN_PASSWORD }) });
  assert(login.ok, 'Verification login failed');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { origin, cookie, 'content-type': 'application/json' };
  const json = async path => { const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(path === '/v1/whoami' ? 60000 : 30000) }); assert(response.ok, `Read failed: ${path}`); return response.json(); };
  const settings = JSON.parse(await readFile(store + '/web-release-settings.json', 'utf8'));
  const { chromium } = createRequire(import.meta.url)(settings.OSD_PLAYWRIGHT_PATH);
  let browser;
  let turnStarted = false;
  let stopped = false;
  try {
    const identity = await json('/v1/whoami');
    const runtime = await json('/api/runtime');
    assert.equal(runtime.runtime, 'opencode');
    const catalog = await json('/provider');
    const modelName = catalog.all.find(provider => provider.id === 'opencode').models[verification.model].name;
    browser = await chromium.launch({ executablePath: settings.OSD_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(cookie.split('; ').map(pair => { const i = pair.indexOf('='); return { name: pair.slice(0, i), value: pair.slice(i + 1), url: origin, httpOnly: true }; }));
    await context.addInitScript(() => localStorage.setItem('ai4s.locale', 'en'));
    const page = await context.newPage();
    const errors = []; const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const url = new URL(request.url()); requests.push({ path: url.pathname, method: request.method(), directory: url.searchParams.get('directory'), at: performance.now() }); });
    await page.goto(origin + '/live/' + verification.sessionId);
    const model = page.getByRole('button', { name: /^Model:/ }).first();
    await model.waitFor({ timeout: 20000 });
    await page.getByText('SCIKEEL_WEB_RELEASE_OK', { exact: true }).first().waitFor({ timeout: 20000 });
    await model.click();
    await page.getByRole('menuitem', { name: modelName, exact: true }).click();
    const chosenModel = 'Model: ' + modelName;
    const timings = [];
    for (let reload = 0; reload < 5; reload++) {
      const offset = requests.length; const started = performance.now();
      await page.reload();
      const selected = page.getByRole('button', { name: chosenModel, exact: true }).first();
      await selected.waitFor({ timeout: 10000 });
      await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === label && !button.disabled), chosenModel, { timeout: 10000 });
      const modelsMs = performance.now() - started;
      await page.getByText('SCIKEEL_WEB_RELEASE_OK', { exact: true }).first().waitFor({ timeout: 10000 });
      const historyMs = performance.now() - started;
      assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).count(), 0);
      assert.equal(requests.slice(offset).filter(row => row.path === '/api/runtime').length, 1);
      assert(requests.slice(offset).some(row => row.path === '/command' && row.directory === identity.directory), 'Session uses the verified workspace');
      timings.push({ modelsMs: Math.round(modelsMs), historyMs: Math.round(historyMs) });
    }
    const beforeEvents = requests.length;
    await page.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(requests.slice(beforeEvents).filter(row => row.path === '/api/runtime').length, 0);
    const prompt = 'Continuity verification only: write a numbered list of 200 short research observations. Do not use tools or change any files. The test will interrupt this response.';
    await page.locator('textarea').first().fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    turnStarted = true;
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 15000 });
    await page.reload();
    await page.getByText(prompt, { exact: true }).first().waitFor({ timeout: 15000 });
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.waitFor({ timeout: 15000 });
    assert.equal(requests.filter(row => row.path.endsWith('/abort')).length, 0, 'Reload does not abort an ongoing turn');
    const abortResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/session/' + verification.sessionId + '/abort' && response.request().method() === 'POST');
    await stop.click();
    assert((await abortResponse).ok(), 'Stop is acknowledged by the worker');
    stopped = true;
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    const sorted = key => timings.map(item => item[key]).sort((a, b) => a - b);
    console.log(JSON.stringify({ phase: 'production Web recovery', release: pointer.id, sessionId: verification.sessionId, viewport: 1280, timings,
      modelsMedianMs: sorted('modelsMs')[2], modelsMaxMs: sorted('modelsMs')[4], historyMedianMs: sorted('historyMs')[2], historyMaxMs: sorted('historyMs')[4], continuity: 'passed', stop: 'passed' }));
  } finally {
    if (turnStarted && !stopped) await fetch(origin + '/session/' + verification.sessionId + '/abort', { method: 'POST', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
    if (browser) await browser.close();
    await fetch(origin + '/auth/logout', { method: 'POST', headers, signal: AbortSignal.timeout(10000) }).catch(() => {});
  }
});

test('production question drafts, last-page absence and confirmed revert work for an isolated acceptance account', {
  skip: process.env.SCIKEEL_RECOVERY_LIVE_ACCEPTANCE !== '1', timeout: 420000,
}, async () => {
  const {randomBytes}=await import('node:crypto');
  const store=commonStore(resolve(fileURLToPath(new URL('../../../',import.meta.url))));
  const pointer=JSON.parse(await readFile(store+'/web-releases/current.json','utf8'));
  const manifest=JSON.parse(await readFile(store+'/web-releases/'+pointer.id+'/manifest.json','utf8'));
  const model={...manifest.deployment?.liveOpenCode,model:process.env.SCIKEEL_CONTINUITY_MODEL||manifest.deployment?.liveOpenCode?.model};
  assert.equal(model?.status,'passed');
  assert(!model.model.toLowerCase().includes('claude'));
  const pid=execFileSync('systemctl',['show','osd-platform.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
  const raw=execFileSync('sudo',['-n','cat',`/proc/${pid}/environ`],{encoding:'utf8'});
  const env=Object.fromEntries(raw.split('\0').map(item=>{const i=item.indexOf('=');return[item.slice(0,i),item.slice(i+1)];}));
  const origin=`http://127.0.0.1:${manifest.deployment.production.port}`;
  const login=async(username,password)=>{
    const response=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(10000)});
    assert(response.ok,'Acceptance login failed');
    return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  };
  const adminCookie=await login(env.PLATFORM_ADMIN_USERNAME||'admin',env.PLATFORM_ADMIN_PASSWORD);
  const username='continuity-'+randomBytes(6).toString('hex'), password=randomBytes(24).toString('hex');
  const created=await fetch(origin+'/api/admin/users',{method:'POST',headers:{origin,cookie:adminCookie,'content-type':'application/json'},body:JSON.stringify({username,password,role:'user'})});
  assert.equal(created.status,201);const account=(await created.json()).user;
  await fetch(origin+'/auth/logout',{method:'POST',headers:{origin,cookie:adminCookie}});
  const cookie=await login(username,password), headers={origin,cookie,'content-type':'application/json'};
  const json=async(path,options={})=>{
    const response=await fetch(origin+path,{headers,signal:AbortSignal.timeout(90000),...options});
    assert(response.ok,`Acceptance request failed: ${path} HTTP ${response.status}`);
    return response.status===204?null:response.json();
  };
  const post=(value)=>({method:'POST',body:JSON.stringify(value)});
  const wait=ms=>new Promise(done=>setTimeout(done,ms));
  const until=async(fn,timeout=120000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await wait(500);}throw new Error('Live interaction acceptance deadline exceeded');};
  const settings=JSON.parse(await readFile(store+'/web-release-settings.json','utf8'));
  const {chromium}=createRequire(import.meta.url)(settings.OSD_PLAYWRIGHT_PATH);
  let browser;const sessions=[],evidence=[];
  try {
    await json('/v1/whoami');
    browser=await chromium.launch({executablePath:settings.OSD_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const other=await json('/session',post({title:'Continuity acceptance navigation target'}));
    for(const width of [1280,360]) {
      const session=await json('/session',post({title:`Continuity acceptance question ${width}px`}));sessions.push(session.id);
      const preference=await json(`/api/collaboration/${session.id}`);
      await json(`/api/collaboration/${session.id}`,post({action:'mode',mode:'autonomous',revision:preference.state.revision}));
      const context=await browser.newContext({viewport:{width,height:900}});
      await context.addCookies(cookie.split('; ').map(pair=>{const i=pair.indexOf('=');return{name:pair.slice(0,i),value:pair.slice(i+1),url:origin,httpOnly:true};}));
      await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
      let page=await context.newPage();const errors=[],requests=[],bad=[];
      const observe=p=>{
        p.on('pageerror',error=>errors.push(error.message));
        p.on('request',request=>requests.push({path:new URL(request.url()).pathname,method:request.method()}));
        p.on('response',response=>{if([400,502].includes(response.status()))bad.push({path:new URL(response.url()).pathname,status:response.status()});});
      };observe(page);
      await page.goto(`${origin}/live/${session.id}`);await page.getByRole('button',{name:/^Model:/}).first().waitFor({timeout:30000});
      const prompt=`Interaction transport acceptance only, not a research task. You MUST invoke the native question tool exactly once now, with one question whose text is "SCIKEEL_METHOD_${width}", one header "Method", two options A and B, and custom text enabled. Wait for my answer. After the answer, reply exactly SCIKEEL_ANSWER_ACCEPTED and stop. Do not invoke other tools or edit files. Do not substitute a plain text question.`;
      await json(`/session/${session.id}/prompt_async`,post({model:{providerID:model.provider,modelID:model.model},parts:[{type:'text',text:prompt}]}));
      const question=await until(async()=>{const list=await json('/question');return list.find(q=>q.sessionID===session.id);});
      assert.equal(question.questions.length,1);assert.equal(question.questions[0].question,`SCIKEEL_METHOD_${width}`);
      const draft=`Keep method B at ${width}px`;
      const answer=()=>page.getByPlaceholder('Or type your own answer…');
      await page.getByText(question.questions[0].question,{exact:true}).waitFor({timeout:20000});
      if(!question.questions[0].custom)await page.getByRole('button',{name:'Something else…',exact:true}).click();
      await answer().waitFor({timeout:20000}).catch(async error=>{throw new Error(`Question field unavailable; custom=${question.questions[0].custom}; page=${(await page.locator('body').innerText()).slice(-4000)}`,{cause:error});});await answer().fill(draft);
      await page.reload();await answer().waitFor({timeout:20000});assert.equal(await answer().inputValue(),draft);
      await page.goto(`${origin}/live/${other.id}`);await page.getByRole('button',{name:/^Model:/}).first().waitFor();
      await page.goto(`${origin}/live/${session.id}`);await answer().waitFor();assert.equal(await answer().inputValue(),draft);
      if(width===360){
        await page.close();await wait(46000);
        assert((await json('/question')).some(q=>q.id===question.id),'Question survives last-page absence');
        page=await context.newPage();observe(page);await page.goto(`${origin}/live/${session.id}`);await answer().waitFor({timeout:20000});assert.equal(await answer().inputValue(),draft);
      }
      const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/question/${question.id}/reply`&&r.request().method()==='POST');
      await page.getByRole('button',{name:'Submit',exact:true}).click();assert((await response).ok(),'Question reply is acknowledged');
      const history=await until(async()=>{
        const list=await json(`/session/${session.id}/message`);
        const part=list.flatMap(m=>m.parts??[]).find(p=>p.type==='tool'&&p.tool==='question'&&p.callID===question.tool?.callID);
        const final=list.find(m=>m.info?.role==='assistant'&&m.info?.time?.completed&&(m.parts??[]).some(p=>p.type==='text'&&p.text?.includes('SCIKEEL_ANSWER_ACCEPTED')));
        return part?.state?.status==='completed'&&final?list:false;
      });
      const receipt=history.flatMap(m=>m.parts??[]).find(p=>p.type==='tool'&&p.callID===question.tool.callID);
      assert.deepEqual(receipt.state.metadata.answers,[[draft]]);
      assert.equal(requests.filter(r=>r.path===`/question/${question.id}/reply`&&r.method==='POST').length,1);
      assert.equal(requests.filter(r=>r.path.endsWith('/abort')).length,0);
      const messageID=history.find(m=>m.info?.role==='user').info.id;
      // User-message controls are revealed by tracked hover (not CSS :hover).
      await page.getByText(prompt,{exact:true}).hover();
      await page.locator('button[aria-label="Revert"]').first().click();
      await page.getByRole('alertdialog').waitFor();
      const reverted=page.waitForResponse(r=>new URL(r.url()).pathname===`/session/${session.id}/revert`&&r.request().method()==='POST');
      await page.getByRole('button',{name:'Revert here',exact:true}).click();assert((await reverted).ok(),'Revert acknowledged');
      await until(async()=>((await json(`/session/${session.id}`)).revert?.messageID===messageID));
      await page.reload();await page.getByRole('button',{name:/^Model:/}).first().waitFor();
      assert.equal((await json(`/session/${session.id}/message`)).length,0,'Reverted history remains hidden after refresh');
      assert.equal(await page.locator('button[aria-label="Revert"]').count(),0);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No phone overflow');
      assert.deepEqual(errors,[]);assert.deepEqual(bad,[]);
      evidence.push({width,sessionId:session.id,question:true,toolCallId:question.tool.callID,draftRecovery:true,navigation:true,replyReceipt:true,replies:1,revertRefresh:true,lastPageAbsenceMs:width===360?46000:0});
      await context.close();
    }
    console.log(JSON.stringify({phase:'production interaction continuity',release:pointer.id,accountId:account.id,provider:model.provider,model:model.model,evidence,status:'passed'}));
  } finally {
    for(const id of sessions)await fetch(origin+`/session/${id}/abort`,{method:'POST',headers,signal:AbortSignal.timeout(10000)}).catch(()=>{});
    await browser?.close();
    await fetch(origin+'/auth/logout',{method:'POST',headers}).catch(()=>{});
    // Only the disposable acceptance account is disabled; its evidence is retained.
    const cleanupCookie=await login(env.PLATFORM_ADMIN_USERNAME||'admin',env.PLATFORM_ADMIN_PASSWORD);
    await fetch(origin+`/api/admin/users/${account.id}/disable`,{method:'POST',headers:{origin,cookie:cleanupCookie,'content-type':'application/json'},body:JSON.stringify({disabled:true}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    await fetch(origin+'/auth/logout',{method:'POST',headers:{origin,cookie:cleanupCookie}}).catch(()=>{});
  }
});
