// @vitest-environment node
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { CollaborationStore } from '../../../../services/platform/src/collaboration.mjs';

test.skipIf(!process.env.OSD_INTERACTION_BROWSER)('Web answers retain drafts across refresh, duplicate clicks, expired requests and confirmed revert', async () => {
  const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const stage=process.env.OSD_WEB_CANDIDATE;
  const html=(await readFile(join(stage,'index.html'),'utf8')).replace('<head>','<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>');
  const root=await mkdtemp(join(tmpdir(),'scikeel-interactions-'));
  let active=true, pending=true, generation=1, replyMode='hold', held, replies=0, aborts=0, revert,permissionReplies=0,permissions=[];
  const sessions=[{id:'ses_live',title:'Interaction recovery fixture',directory:'/tenant/workspace',time:{created:Date.now(),updated:Date.now()}},
    {id:'ses_other',title:'Other conversation',directory:'/tenant/workspace',time:{created:Date.now()-1,updated:Date.now()-1}}];
  const question={id:'question_live',sessionID:'ses_live',tool:{messageID:'msg_assistant',callID:'call_question'},questions:[{question:'Which method should we use?',header:'Method',options:[{label:'A',description:'Method A'}],custom:true}]};
  const generated=new Map(), sends=[];
  const owner={userId:'usr_fixture',sessionId:'ses_live',runtime:'opencode',directory:'/tenant/workspace',workspaceDir:'/tenant/workspace'};
  const store=new CollaborationStore({rootDir:root,running:async(o)=>o.sessionId==='ses_live'?active:!!generated.get(o.sessionId)?.active,cancel:async()=>{active=false;aborts++;}});
  await store.begin(owner,0);
  let toolState={status:'running',input:{questions:question.questions}};
  const history=()=>[
    {info:{id:'msg_user',sessionID:'ses_live',role:'user',time:{created:1}},parts:[{id:'part_user',type:'text',text:'Inspect the interaction fixture'}]},
    {info:{id:'msg_assistant',sessionID:'ses_live',role:'assistant',time:{created:2,...(!active?{completed:3}:{})}},parts:[{id:'part_question',type:'tool',tool:'question',callID:'call_question',state:toolState}]},
  ];
  const streams=new Set();
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://fixture');const path=url.pathname;
      const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-scikeel-runtime-generation':String(generation)});res.end(JSON.stringify(value));};
      if(path.startsWith('/assets/')){
        const file=resolve(stage,`.${path}`);if(!file.startsWith(`${stage}/assets/`)){json({},403);return;}
        res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(file)]??'application/octet-stream'});res.end(await readFile(file));return;
      }
      if(path==='/' || path.startsWith('/live')){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
      if(path==='/event'){res.writeHead(200,{'content-type':'text/event-stream','x-scikeel-runtime-generation':String(generation)});res.write('data: {"type":"server.connected","properties":{}}\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
      let bytes='';if(req.method!=='GET')for await(const chunk of req)bytes+=chunk;const body=bytes?JSON.parse(bytes):{};
      if(path==='/session' && req.method==='POST') {
        const session={id:`ses_new${generated.size+1}`,title:body.title??'Starter fixture',directory:'/tenant/workspace',time:{created:Date.now(),updated:Date.now()}};
        sessions.push(session);generated.set(session.id,{session,history:[],active:false});json(session);return;
      }
      const generatedPath=/^\/session\/(ses_new[0-9]+)(?:\/(.+))?$/.exec(path);
      if(generatedPath) {
        const record=generated.get(generatedPath[1]);
        if(generatedPath[2]==='prompt_async') {
          const requestOwner={...owner,sessionId:record.session.id};const state=await store.get(requestOwner);await store.begin(requestOwner,state.revision);
          const text=body.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
          record.active=true;record.history=[{info:{id:`msg_${record.session.id}`,sessionID:record.session.id,role:'user',time:{created:Date.now()}},parts:[{type:'text',text}]}];
          sends.push({sessionId:record.session.id,text});setTimeout(()=>json({},202),1000);return;
        }
        json(generatedPath[2]==='message'?record.history:generatedPath[2]==='children'?[]:record.session);return;
      }
      if(path.startsWith('/api/collaboration/')){
        const currentOwner={...owner,sessionId:path.split('/').at(-1)};
        if(body.action==='heartbeat')await store.heartbeat(currentOwner,body.pageId);
        if(body.action==='release')await store.release(currentOwner,body.pageId);
        if(body.action==='pause')await store.pause(currentOwner);
        json({available:true,state:await store.get(currentOwner)});return;
      }
      if(path==='/question/question_live/reply'){
        replies++;
        if(replyMode==='expired'){pending=false;json({name:'QuestionNotFoundError',data:{message:'Question is no longer pending'}},400);return;}
        const accept=()=>{pending=false;toolState={status:'completed',input:{questions:question.questions},metadata:{answers:body.answers},output:'User answered the question.'};};
        if(replyMode==='lost'){accept();json({error:'Interaction delivery is not confirmed',code:'interaction_delivery_unknown',source:'gateway'},503);return;}
        held=()=>{accept();json(true);};return;
      }
      if(path==='/permission/permission_live/reply') {
        permissionReplies++;
        if(replyMode==='expired'){permissions=[];json({_tag:'PermissionNotFoundError',message:'Permission request not found'},404);return;}
        held=()=>{permissions=[];json(true);};return;
      }
      if(path==='/session/ses_live/abort'){active=false;aborts++;await store.settled(owner);json(true);return;}
      if(path==='/session/ses_live/revert'){revert={messageID:body.messageID};json({...sessions[0],revert});return;}
      const data={
        '/v1/whoami':{directory:'/tenant/workspace',mode:'full'},'/api/me':{user:{id:'usr_fixture',username:'fixture',role:'user'}},
        '/api/runtime':{runtime:'opencode',kind:'opencode',context:{instanceId:'user-fixture',generation},available:[{runtime:'opencode',kind:'opencode',enabled:true}]},
        '/config/providers':{providers:[{id:'fixture',name:'Fixture',models:{model:{id:'model',name:'Fixture model'}}}],connected:['fixture'],default:{fixture:'model'}},
        '/provider':{all:[],connected:['fixture']},'/config':{model:'fixture/model'},'/global/config':{model:'fixture/model'},
        '/experimental/session':sessions,'/session':sessions,'/session/status':{...(active?{ses_live:{type:'busy'}}:{}),...Object.fromEntries([...generated].filter(([,record])=>record.active).map(([id])=>[id,{type:'busy'}]))},
        '/session/ses_live':{...sessions[0],...(revert?{revert}:{})},'/session/ses_other':sessions[1],
        '/session/ses_live/message':revert?[]:history(),'/session/ses_other/message':[],
        '/question':pending?[question]:[], '/permission':permissions, '/skill':[], '/agent':[{name:'build',mode:'primary'}],'/command':[], '/v1/projects':[], '/v1/fs/list':[],
      };
      json(data[path]??(path.startsWith('/api/research/')?{task:null}:{}));
    } catch {res.writeHead(500);res.end('{}');}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    for(const width of [1280,360]) {
      const state=await store.get(owner);if(state.phase!=="running")await store.begin(owner,state.revision);
      pending=true;active=true;revert=undefined;toolState={status:'running',input:{questions:question.questions}};replyMode='hold';held=undefined;
      const context=await browser.newContext({viewport:{width,height:900}});
      try {
        await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${origin}/live/ses_live`);await page.getByText(question.questions[0].question,{exact:true}).waitFor();
        const answer=page.getByPlaceholder('Or type your own answer…');await answer.fill('Keep my method and notes');
        await page.reload();await expect.poll(()=>answer.inputValue()).toBe('Keep my method and notes');
        const navigationAborts=aborts;
        await page.goto(`${origin}/live/ses_other`);
        await page.goto(`${origin}/live/ses_live`);
        await expect.poll(()=>answer.inputValue()).toBe('Keep my method and notes');expect(aborts).toBe(navigationAborts);
        const before=replies;await page.getByRole('button',{name:'Submit',exact:true}).click();
        await page.getByText('Submitting your answer…',{exact:true}).waitFor();expect(replies).toBe(before+1);
        expect(await page.getByRole('button',{name:'Submit',exact:true}).isDisabled()).toBe(true);
        held();await expect.poll(()=>page.getByText(question.questions[0].question,{exact:true}).count()).toBe(0);
        // A native 400 expiration preserves the input and never makes the session disappear.
        pending=true;replyMode='expired';toolState={status:'running',input:{questions:question.questions}};
        await page.reload();await answer.fill('Expired answer remains editable as a draft');
        await page.getByRole('button',{name:'Submit',exact:true}).click();await page.getByText('This request has expired. Your answer is saved.',{exact:true}).waitFor();
        await page.reload();await page.getByText('This request has expired. Your answer is saved.',{exact:true}).waitFor();
        expect(await answer.inputValue()).toBe('Expired answer remains editable as a draft');
        expect(await page.getByRole('button',{name:'Submit',exact:true}).isDisabled()).toBe(true);
        // The same exact question tool proves a lost acknowledgement without a second POST.
        pending=true;replyMode='lost';generation++;toolState={status:'running',input:{questions:question.questions}};
        await page.reload();await answer.fill('Read back my accepted answer');const lostBefore=replies;
        await page.getByRole('button',{name:'Submit',exact:true}).click();
        await expect.poll(()=>page.getByText(question.questions[0].question,{exact:true}).count()).toBe(0);
        expect(replies).toBe(lostBefore+1);
        // Permission decisions are never persisted or replayed as new grants.
        permissions=[{id:'permission_live',sessionID:'ses_live',permission:'bash',patterns:['printf verified'],tool:{messageID:'msg_assistant',callID:'call_permission'}}];
        replyMode='hold';await page.reload();
        await page.getByRole('button',{name:'Allow once',exact:true}).waitFor();
        const permissionBefore=permissionReplies;
        await page.getByRole('button',{name:'Allow once',exact:true}).click();
        await page.getByText('Submitting your decision…',{exact:true}).waitFor();
        expect(await page.getByRole('button',{name:'Allow once',exact:true}).isDisabled()).toBe(true);
        held();await expect.poll(()=>page.getByRole('button',{name:'Allow once',exact:true}).count()).toBe(0);
        expect(permissionReplies).toBe(permissionBefore+1);
        // An accepted run is independent of page presence; use the real collaboration state.
        const abortBefore=aborts;await context.close();await store.release(owner,'closed-page');
        const originalNow=store.now;
        if(width===360)await new Promise(done=>setTimeout(done,46000));
        else store.now=()=>Date.now()+46000;
        await store.tick();store.now=originalNow;
        expect((await store.get(owner)).phase).toBe('running');expect(aborts).toBe(abortBefore);
        const reopened=await browser.newContext({viewport:{width,height:900}});
        try {
          await reopened.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
          const restored=await reopened.newPage();await restored.goto(`${origin}/live/ses_live`);
          await restored.getByText('Inspect the interaction fixture',{exact:true}).waitFor();
          await restored.getByText('Inspect the interaction fixture',{exact:true}).hover();
          await restored.locator('button[aria-label="Revert"]').first().click();
          await restored.getByRole('button',{name:'Revert here',exact:true}).click();
          await expect.poll(()=>revert?.messageID).toBe('msg_user');
          await expect.poll(()=>restored.locator('button[aria-label="Revert"]').count()).toBe(0);
          await expect.poll(()=>restored.locator('textarea').first().inputValue()).toBe('Inspect the interaction fixture');
          expect(aborts).toBe(abortBefore+1);
          await restored.reload();await restored.locator('textarea').first().waitFor();
          expect(await restored.locator('button[aria-label="Revert"]').count()).toBe(0);
        } finally {await reopened.close();}
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }

    for(const width of [1280,360])for(const title of ['Start from a research idea','Run a demo analysis, end to end','Analyze my data','Audit a report for traceability','Explore an example: climate trends',null]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      try {
        await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
        const page=await context.newPage();await page.goto(`${origin}/live`);
        await page.getByRole('heading',{name:'What should we look into?'}).waitFor();
        const before=sends.length, beforeAborts=aborts;
        if(title)await page.getByRole('button',{name:new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();
        else {await page.locator('textarea').first().fill('My own research question');await page.locator('textarea').first().press('Enter');}
        await expect.poll(()=>sends.length).toBe(before+1);
        const sent=sends[sends.length-1];
        await page.reload();await page.goto(`${origin}/live/${sent.sessionId}`);
        await page.getByText(sent.text,{exact:true}).first().waitFor();
        expect(sends.length).toBe(before+1);expect(aborts).toBe(beforeAborts);
        expect(generated.get(sent.sessionId).active).toBe(true);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      } finally {await context.close();}
    }
  } finally {await browser.close();for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
},120000);
