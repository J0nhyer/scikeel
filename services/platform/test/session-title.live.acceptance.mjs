import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {commonStore} from '../../../scripts/dev/web-release-source.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

test('production titles use two authorized models and refresh the live Web sidebar', {skip: process.env.SCIKEEL_TITLE_LIVE_ACCEPTANCE !== '1', timeout: 420000}, async () => {
const port=Number(process.env.SCIKEEL_RELEASE_PORT||4790);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid verification port');
const origin=`http://127.0.0.1:${port}`;
const pid=execFileSync('systemctl',['show','osd-platform.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
const raw=execFileSync('sudo',['-n','cat',`/proc/${pid}/environ`],{encoding:'utf8'});
const env=Object.fromEntries(raw.split('\0').map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
const login=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:env.PLATFORM_ADMIN_USERNAME||'admin',password:env.PLATFORM_ADMIN_PASSWORD})});
if(!login.ok)throw Error('Verification login failed');
const headers={origin,'content-type':'application/json',cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
async function json(path,method='GET',body){const r=await fetch(origin+path,{method,headers:{...headers,...(method==='DELETE'?{'x-scikeel-manual-approval':'1'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});if(!r.ok)throw Error(`${method} ${path}: ${r.status}`);return r.status===204?null:r.json()}
const sessions=[]; let browser;
try {
 const catalog=await json('/provider');
 const provider=catalog.all.find(x=>x.id==='opencode'&&catalog.connected.includes(x.id));
 const models=Object.keys(provider?.models||{}).filter(x=>x==='big-pickle'||x.endsWith('-free')).filter(x=>!x.toLowerCase().includes('claude'));
 console.log('Authorized non-Claude models:',models.join(', '));
 if(process.argv.includes('--catalog'))process.exitCode=0;
 else {
  if(models.length<2)throw Error('Two authorized non-Claude models required');
  const chosen = [...new Set(['big-pickle', 'fledge-alpha-free', ...models.filter(id=>id!=='space-bunny-free')].filter(id=>models.includes(id)))].slice(0,2);
  const settings=JSON.parse(await readFile(commonStore(resolve(fileURLToPath(new URL('../../../', import.meta.url))))+'/web-release-settings.json','utf8'));
  const {chromium}=createRequire(import.meta.url)(settings.OSD_PLAYWRIGHT_PATH);
  browser=await chromium.launch({executablePath:settings.OSD_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const [index,modelID]of chosen.entries()){
   const session=await json('/session','POST',{});
   if(!/^ses_[A-Za-z0-9]+$/.test(session.id)) throw Error('Unexpected verification session identity');
   sessions.push(session.id);
   const width=index?390:1280;
   const context=await browser.newContext({viewport:{width,height:900}});
   await context.addCookies(headers.cookie.split('; ').map(pair=>{const boundary=pair.indexOf('=');return {name:pair.slice(0,boundary),value:pair.slice(boundary+1),url:origin,httpOnly:true}}));
   await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
   const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
   const openRail=async()=>{const button=page.getByRole('button',{name:'Expand sidebar',exact:true});if(await button.isVisible())await button.click()};
   await page.goto(origin+'/live/'+session.id);await page.locator('textarea').first().waitFor();await openRail();
   const link=page.locator(`a[href="/live/${session.id}"]`).first();await link.waitFor();
   await json('/api/collaboration/'+session.id,'POST',{action:'heartbeat',pageId:'title-release-verification'});
   const answer=await json('/session/'+session.id+'/message','POST',{model:{providerID:'opencode',modelID},parts:[{type:'text',text:`Discuss ${index?'single-cell RNA sequencing':'reproducible EEG research'}. This is a verification request. Reply briefly without tools or filesystem changes.`}]});
   if(answer.info?.error)throw Error('Conversation model returned an error');
   let info;const deadline=Date.now()+40000;
   while(Date.now()<deadline){info=await json('/session/'+session.id);const job=info.metadata?.scikeelSessionTitle;if(job?.status==='completed')break;if(job?.status==='failed')throw Error(`Title failed for ${modelID}`);await delay(1000)}
   const job=info.metadata?.scikeelSessionTitle;
   if(job?.source!=='automatic'||job.status!=='completed'||job.model?.providerID!=='opencode'||job.model?.modelID!==modelID||info.title===session.title)throw Error(`Automatic title verification failed for ${modelID}`);
   await page.waitForFunction(({id,title})=>Array.from(document.querySelectorAll('a')).some(a=>a.getAttribute('href')==='/live/'+id&&a.textContent.includes(title)),{id:session.id,title:info.title});
   await page.reload();await page.locator('textarea').first().waitFor();await openRail();
   if(!(await link.innerText()).includes(info.title))throw Error('Committed title did not survive Web reload');
   if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw Error('Web viewport overflows');
   if(errors.length)throw Error('Production Web browser errors: '+errors.join('; '));
   console.log(JSON.stringify({modelID,title:info.title,attempts:job.attempts,status:job.status,viewport:width,liveSidebar:'passed'}));
   await json('/session/'+session.id,'PATCH',{title:info.title});
   const renamed=await json('/session/'+session.id);if(renamed.metadata?.scikeelSessionTitle.source!=='manual')throw Error('Same-title manual intent was not saved');
   await context.close();
  }
  console.log('Live title acceptance passed.');
 }
}finally{
 if(browser)await browser.close();
 for(const id of sessions)await json('/session/'+id,'DELETE');
 await fetch(origin+'/auth/logout',{method:'POST',headers});
}

});
