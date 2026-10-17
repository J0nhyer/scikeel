// @vitest-environment node
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {extname,join,resolve} from 'node:path';
import {expect,test} from 'vitest';
import {AttachmentStore} from '../../../../services/platform/src/attachments.mjs';
import {createAttachmentRouter} from '../../../../services/platform/src/attachment-routes.mjs';

test.skipIf(process.env.OSD_ASSISTANT_BROWSER!=='1')('Admin cutover preserves ordinary Web conversations and fences stale work at desktop and phone widths',async()=>{
 const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
 const stage=resolve(process.env.OSD_WEB_CANDIDATE),root=await mkdtemp(join(tmpdir(),'scikeel-assistant-browser-'));
 const html=(await readFile(join(stage,'index.html'),'utf8')).replace('<head>','<head><script>window.__OS_WEB__=true;window.__OS_PLATFORM__=true;</script>');
 const evidence=resolve(stage,'../verification/assistant-compatibility');await mkdir(evidence,{recursive:true});
 const files=new AttachmentStore({rootDir:root});await files.init();
 let runtime='opencode',revision=1,width=1280,active=false,questionPending=true,aborts=0,accepted=0;
 let history=[],operations=new Map();const writes=[],streams=new Set(),timers=new Set();
 const session={id:'ses_legacy',title:'Existing research conversation',directory:'/tenant/workspace',time:{created:1,updated:2}};
 const questionSession={...session,id:'ses_question',title:'Question draft conversation'};
 const question={id:'question_old',sessionID:questionSession.id,tool:{messageID:'msg_question',callID:'question_call'},
  questions:[{question:'Choose a verification method',header:'Method',options:[{label:'A',description:'Method A'}],custom:true}]};
 const questionHistory=[{info:{id:'msg_question_user',sessionID:questionSession.id,role:'user',time:{created:1}},parts:[{type:'text',text:'Question history retained'}]},
  {info:{id:'msg_question',sessionID:questionSession.id,role:'assistant',time:{created:2}},parts:[{
   id:'part_question',type:'tool',tool:'question',callID:'question_call',state:{status:'running',input:{questions:question.questions}}}]}];
 const decision={id:'confirmed_method',kind:'method',execution:1,question:'Which method?',answer:'Use all observations',answeredAt:1};
 const user=req=>({id:`usr_${width}_${req.headers['x-fixture-role']==='admin'?'admin':'student'}`,username:'Fixture',
  role:req.headers['x-fixture-role']==='admin'?'admin':'user'});
 const attachmentRouter=createAttachmentRouter({store:files,resolveOwner:async(_user,id)=>{
  if(![session.id,questionSession.id].includes(id))throw Object.assign(Error('Unknown conversation'),{status:403});return session;
 }});
 const options=()=>['opencode','codex','claude'].map(id=>({runtime:id,kind:id==='opencode'?'opencode':'server',managed:id!=='opencode',
  label:id==='codex'?'Codex':id==='claude'?'Claude Code':'OpenCode',enabled:id===runtime,status:id==='claude'?'unavailable':'ready',
  models:id==='codex'?['gpt-6.1-sol']:id==='opencode'?['model']:[],defaultModel:id==='codex'?'gpt-6.1-sol':id==='opencode'?'model':null,
  selectedModel:id==='codex'?'gpt-6.1-sol':id==='opencode'?'model':null}));
 const catalog=()=>({providers:[{id:runtime==='opencode'?'fixture':'codex',name:runtime==='opencode'?'Legacy provider':'Codex',
  models:runtime==='opencode'?{model:{id:'model',name:'Legacy model'}}:{'gpt-6.1-sol':{id:'gpt-6.1-sol',name:'gpt-6.1-sol',variants:{low:{reasoningEffort:'low'}}}}}],
  connected:[runtime==='opencode'?'fixture':'codex'],default:runtime==='opencode'?{fixture:'model'}:{codex:'gpt-6.1-sol'}});
 const emit=event=>{for(const response of streams)response.write(`data: ${JSON.stringify(event)}\n\n`);};
 const server=createServer(async(req,res)=>{
  try {
   const path=new URL(req.url,'http://fixture').pathname,identity=user(req);
   const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',
    'x-scikeel-runtime-generation':'1'});res.end(JSON.stringify(value));};
   if(path.startsWith('/assets/')){
    const file=resolve(stage,'.'+path);if(!file.startsWith(stage+'/assets/')){json({},403);return;}
    try{res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]??'application/octet-stream'});res.end(await readFile(file));}
    catch{res.writeHead(404);res.end();}return;
   }
   if(path==='/'||path.startsWith('/live')||path.startsWith('/settings')){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
   if(path==='/event'){
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"server.connected","properties":{}}\n\n');
    streams.add(res);res.on('close',()=>streams.delete(res));return;
   }
   if(path.startsWith('/api/attachments')){await attachmentRouter(req,res,identity);return;}
   let raw='';if(!['GET','HEAD'].includes(req.method))for await(const chunk of req)raw+=chunk;
   const body=raw?JSON.parse(raw):{};
   if(path==='/api/admin/runtime'){
    if(identity.role!=='admin'){json({error:'forbidden'},403);return;}
    if(req.method==='POST'){
     writes.push({path,body});
     if(body.expectedRevision!==revision||!['codex','opencode'].includes(body.runtime)){json({error:'assistant_revision_conflict'},409);return;}
     runtime=body.runtime;revision++;questionPending=false;
     const receipt={activeRuntime:runtime,revision,operationId:body.operationId};operations.set(body.operationId,receipt);
     json(receipt);return;
    }
    const operationId=new URL(req.url,'http://fixture').searchParams.get('operationId'),receipt=operations.get(operationId);
    json({activeRuntime:runtime,revision,recoveryRequired:false,available:options(),operation:operationId?{
     operationId,state:receipt?'committed':'unknown',...(receipt?{result:receipt}:{})}:null});return;
   }
   if(path===`/session/${session.id}/prompt_async`){
    writes.push({path,body,revision:req.headers['x-scikeel-assistant-revision'],requestId:req.headers['x-scikeel-request-id']});
    if(req.headers['x-scikeel-assistant-revision']!==String(revision)){
     json({error:'assistant_revision_conflict',code:'assistant_revision_conflict'},409);return;
    }
    expect(body.model).toEqual({providerID:'codex',modelID:'gpt-6.1-sol'});accepted++;active=true;
    const prompt=body.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    const turn=body.attachmentTurn?await files.prepareTurn(identity.id,session.id,body.attachmentTurn,prompt):null;
    if(turn)await files.finishTurn(identity.id,session.id,turn.turnId,'accepted');
    const attachments=turn?await Promise.all(turn.attachmentIds.map(id=>files.get(identity.id,{sessionId:session.id},id))):[];
    history.push({info:{id:turn?.messageID??'msg_new_user',sessionID:session.id,role:'user',time:{created:3}},
     parts:[{type:'text',text:prompt}],attachments});
    const assistant={info:{id:'msg_native',sessionID:session.id,role:'assistant',time:{created:4},providerID:'codex',modelID:'gpt-6.1-sol'},
     parts:[{id:'part_native_tool',sessionID:session.id,messageID:'msg_native',type:'tool',tool:'webfetch',callID:'native_call',
      state:{status:'running',input:{url:'https://example.com/'},title:'Scoped public fetch'}}]};
    history.push(assistant);json({},202);
    const timer=setTimeout(()=>{timers.delete(timer);emit({type:'message.updated',properties:{info:assistant.info}});
     emit({type:'message.part.updated',properties:{part:assistant.parts[0]}});},100);timers.add(timer);return;
   }
   if(path===`/session/${session.id}/abort`){
    aborts++;active=false;const assistant=history.find(message=>message.info.id==='msg_native');
    if(assistant){assistant.info.time.completed=5;assistant.parts[0].state={...assistant.parts[0].state,status:'error',error:'Execution stopped'};}
    emit({type:'session.idle',properties:{sessionID:session.id}});json(true);return;
   }
   if(path.startsWith('/question/')&&req.method==='POST'){
    writes.push({path,body});json({error:'assistant_revision_conflict',code:'assistant_revision_conflict'},409);return;
   }
   if(path.startsWith('/api/collaboration/')){
    if(body.action&&!['heartbeat','release'].includes(body.action))writes.push({path,body});
    json({available:true,state:{version:1,mode:'autonomous',phase:path.endsWith(session.id)&&active?'running':'idle',revision:1,
     execution:1,decisions:[decision],pending:null}});return;
   }
   const data={
    '/api/me':{user:identity},'/v1/whoami':{directory:session.directory,mode:'full'},
    '/api/runtime':{runtime,kind:runtime==='opencode'?'opencode':'server',label:runtime==='opencode'?'OpenCode':'Codex',policyRevision:revision,
     context:{instanceId:'fixture-worker',generation:1},available:options()},
    '/api/workspace/status':{context:{instanceId:'fixture-worker',generation:1},state:'healthy',activity:'idle',canRestart:false,retryAfterMs:0},
    '/api/workspace/operations':{items:[],resolved:[],nextCursor:null},
    '/config/providers':catalog(),'/provider':{all:catalog().providers,connected:catalog().connected},
    '/config':{model:runtime==='opencode'?'fixture/model':'codex/gpt-6.1-sol'},
    '/global/config':{model:runtime==='opencode'?'fixture/model':'codex/gpt-6.1-sol'},
    '/experimental/session':[session,questionSession],'/session':[session,questionSession],
    '/session/status':active?{[session.id]:{type:'busy'}}:{},
    [`/session/${session.id}`]:session,[`/session/${questionSession.id}`]:questionSession,
    [`/session/${session.id}/message`]:history,[`/session/${questionSession.id}/message`]:questionHistory,
    [`/session/${session.id}/children`]:[],[`/session/${questionSession.id}/children`]:[],
    '/permission':[],'/question':questionPending?[question]:[],
    '/agent':[{name:'build',mode:'primary'}],'/skill':[],'/command':[],'/v1/projects':[],'/v1/fs/list':[],
   };
   if(path in data){json(data[path]);return;}
   if(path.startsWith('/api/research/')){json({task:null});return;}
   json({error:'Unknown acceptance route'},404);
  }catch(error){if(!res.headersSent){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}else res.destroy();}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const report=[];
 try{
  for(width of [1280,390,320]){
   runtime='opencode';revision=1;active=false;questionPending=true;aborts=accepted=0;operations=new Map();writes.length=0;
   history=[{info:{id:'msg_legacy_user',sessionID:session.id,role:'user',time:{created:1}},parts:[{type:'text',text:'Original research request'}]},
    {info:{id:'msg_legacy_answer',sessionID:session.id,role:'assistant',time:{created:2,completed:3}},parts:[{type:'text',text:'Original research history retained'}]}];
   const contexts=[];const errors=[];
   const open=async role=>{
    const context=await browser.newContext({viewport:{width,height:900},extraHTTPHeaders:{'x-fixture-role':role}});contexts.push(context);
    await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return {context,page};
   };
   try{
    const student=await open('user'),admin=await open('admin');
    const page=student.page;await page.goto(origin+'/live/'+session.id);
    await page.getByText('Original research history retained',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Model: Legacy model',exact:true}).first().waitFor();
    expect(await page.getByRole('radiogroup',{name:'AI assistant'}).count()).toBe(0);
    await page.locator('textarea').first().fill('Preserved cutover draft');
    await page.locator('input[type="file"]').first().setInputFiles({name:'preserved.csv',mimeType:'text/csv',buffer:Buffer.from('value\n1\n2\n')});
    await page.getByRole('button',{name:'Remove preserved.csv',exact:true}).waitFor();
    const questionPage=await student.context.newPage();questionPage.on('pageerror',error=>errors.push(error.message));
    await questionPage.goto(origin+'/live/'+questionSession.id);
    await questionPage.getByText(question.questions[0].question,{exact:true}).waitFor();
    const answer=questionPage.getByPlaceholder(/Or type your own answer/);await answer.fill('Preserved method answer');
    await admin.page.goto(origin+'/settings/models');
    const group=admin.page.getByRole('radiogroup',{name:'AI assistant'});await group.waitFor();
    await expect.poll(()=>group.getByRole('radio',{name:'OpenCode',exact:true}).isChecked()).toBe(true);
    expect(await group.getByRole('radio',{name:'Claude Code',exact:true}).isDisabled()).toBe(true);
    await group.getByRole('radio',{name:'Codex',exact:true}).click();
    await expect.poll(()=>group.getByRole('radio',{name:'Codex',exact:true}).isChecked()).toBe(true);
    expect(writes.filter(row=>row.path==='/api/admin/runtime')).toHaveLength(1);
    expect(runtime).toBe('codex');expect(revision).toBe(2);expect(accepted).toBe(0);
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>writes.filter(row=>row.path.endsWith('/prompt_async')).length).toBe(1);
    await expect.poll(()=>page.getByRole('button',{name:/^Model: (gpt-6\.1-sol|No models available)$/}).first().isEnabled()).toBe(true);
    expect(accepted).toBe(0);expect(aborts).toBe(0);
    expect(await page.locator('textarea').first().inputValue()).toBe('Preserved cutover draft');
    expect(await page.getByRole('button',{name:'Remove preserved.csv',exact:true}).count()).toBe(1);
    const model=page.getByRole('button',{name:/^Model:/}).first();await model.click();
    if(width<768)await page.locator('[data-choice-row]').filter({hasText:'gpt-6.1-sol'}).click();
    else await page.getByRole('menuitem',{name:'gpt-6.1-sol',exact:true}).click();
    await questionPage.reload();await expect.poll(()=>answer.inputValue()).toBe('Preserved method answer');
    expect(await questionPage.getByRole('button',{name:'Submit',exact:true}).isDisabled()).toBe(true);
    expect(writes.filter(row=>row.path.startsWith('/question/'))).toHaveLength(0);
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>accepted).toBe(1);
    await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
    await page.getByText('https://example.com/',{exact:true}).first().waitFor();
    await page.getByRole('button',{name:'Remove preserved.csv',exact:true}).waitFor({state:'detached'});
    await page.reload();await page.getByText('Original research history retained',{exact:true}).waitFor();
    await page.getByText('https://example.com/',{exact:true}).first().waitFor();
    await page.getByRole('button',{name:'Stop',exact:true}).waitFor();expect(accepted).toBe(1);expect(aborts).toBe(0);
    await page.screenshot({path:join(evidence,`running-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'Stop',exact:true}).click();await expect.poll(()=>aborts).toBe(1);
    await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'detached'});
    expect((await (await student.context.request.get(origin+'/api/collaboration/'+session.id)).json()).state.decisions).toEqual([decision]);
    await page.goto(origin+'/settings/models');
    expect(await page.getByRole('radiogroup',{name:'AI assistant'}).count()).toBe(0);
    expect(writes.filter(row=>row.path==='/api/admin/runtime')).toHaveLength(1);
    for(const visible of [page,admin.page,questionPage])expect(await visible.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await admin.page.screenshot({path:join(evidence,`admin-${width}.png`),fullPage:true});
    expect(errors).toEqual([]);report.push({width,adminSelections:1,staleRejected:1,explicitResends:accepted,confirmedStops:aborts});
   }catch(error){
    console.log(JSON.stringify({width,runtime,revision,accepted,aborts,writes,errors}));
    for(const [index,context]of contexts.entries())for(const [tab,page]of context.pages().entries()){
     console.log(JSON.stringify({context:index,tab,text:(await page.locator('body').innerText()).slice(-5000)}));
     await page.screenshot({path:join(evidence,`failed-${width}-${index}-${tab}.png`),fullPage:true});
    }
    throw error;
   }finally{for(const context of contexts)await context.close();}
  }
  console.log(JSON.stringify({phase:'Assistant compatibility browser acceptance',results:report}));
 }finally{
  await browser.close();for(const timer of timers)clearTimeout(timer);for(const response of streams)response.destroy();
  server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});
 }
},180000);
