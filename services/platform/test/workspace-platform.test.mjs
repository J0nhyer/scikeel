import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuthStore} from '../src/auth-store.mjs';
import {PlatformServer} from '../src/platform-server.mjs';
import {TenantPolicy} from '../src/tenant-policy.mjs';
import {workspaceError} from '../src/workspace-state.mjs';

test('actual platform routes retain project payload, hide archived runtime lists, block old access and restore',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workspace-platform-'));
  const project={id:'123456789abcdef0',name:'A',path:root+'/workspace/projects/a',createdAt:1,pinned:false,imported:false};
  const payload='retained bytes';let upstreamReads=0,projectResponse='normal',chunksSent=0,releaseCreate,createStarted;
  const upstream=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://worker');res.setHeader('content-type','application/json');
    if(url.pathname==='/v1/projects'){
      if(req.method==='POST'){createStarted();await new Promise(done=>{releaseCreate=done;});return res.end(JSON.stringify(project));}
      if(projectResponse==='declared'){res.setHeader('content-length',String(16*1024**2+1));res.flushHeaders();const timer=setTimeout(()=>res.destroy(),1000);res.once('close',()=>clearTimeout(timer));return;}
      if(projectResponse==='streamed'){
        res.write('{"padding":"');const timer=setInterval(()=>{chunksSent++;res.write('x'.repeat(256*1024));if(chunksSent===68){clearInterval(timer);res.end('"}');}},1);
        res.once('close',()=>clearInterval(timer));return;
      }
      if(projectResponse==='malformed')return res.end('{invalid');
      if(projectResponse==='encoding')return res.end(Buffer.from([0x22,0xff,0x22]));
      return res.end(JSON.stringify([project]));
    }
    if(url.pathname==='/v1/projects/'+project.id && req.method==='PATCH'){
      let body='';for await(const chunk of req)body+=chunk;project.name=JSON.parse(body).name;return res.end('{"ok":true}');
    }
    if(['/session','/experimental/session'].includes(url.pathname))return res.end(JSON.stringify([{id:'ses_a',directory:project.path,title:'private title'}]));
    if(url.pathname==='/session/ses_a')return res.end(JSON.stringify({id:'ses_a',directory:project.path}));
    if(['/session/ses_a/message','/session/ses_a/children'].includes(url.pathname))return res.end('[]');
    if(url.pathname==='/session/ses_a/abort')return res.end('true');
    if(['/session/status','/permission','/question'].includes(url.pathname))return res.end(url.pathname==='/session/status'?'{}':'[]');
    if(url.pathname==='/v1/fs/ticket')return res.end(JSON.stringify({ticket:'raw-worker-ticket',path:'notes.txt'}));
    if(url.pathname==='/v1/fs/read'){upstreamReads++;return res.end(payload);}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
  const authStore=new AuthStore({filePath:join(root,'auth.json'),bootstrapAdmin:{username:'admin',password:'test-password'}});
  const policy=new TenantPolicy();let worker;
  const manager={rootDir:join(root,'workers'),init:async()=>{},getWorker:()=>worker,getWorkerAccess:()=>({url:`http://127.0.0.1:${upstream.address().port}`,token:'internal'}),
    ensureWorker:async({userId})=>{
      const user={id:userId};
      worker={id:'user-'+user.id,userId:user.id,generation:1,status:'running',workspaceDir:root+'/workspace'};
      policy.registerAccount({userId:user.id,instanceId:worker.id,generation:1,workspaceDir:worker.workspaceDir});return {...worker,...manager.getWorkerAccess()};
    },retainWorker:()=>({release(){}})};
  const server=new PlatformServer({authStore,workerManager:manager,tenantPolicy:policy,enableWorkspaceManagement:true});
  t.after(async()=>{await server.close();await new Promise(done=>upstream.close(done));await rm(root,{recursive:true,force:true});});
  const address=await server.listen();const base=`http://${address.host}:${address.port}`;
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({username:'admin',password:'test-password'})});
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const request=(path,method='GET',body)=>fetch(base+path,{method,headers:{cookie,origin:base,accept:'application/json','content-type':'application/json','x-scikeel-runtime-generation':'1'},...(body?{body:JSON.stringify(body)}:{})});
  const malformed=await request('/v1/fs/ticket?root=bad&path=notes.txt&ignored=x');assert.equal(malformed.status,400);
  const listed=await request('/api/workspace/projects');assert.equal(listed.status,200);const [p]=await listed.json();
  const ticket=await (await request('/v1/fs/ticket?root=workspace&path=notes.txt&dir='+encodeURIComponent(project.path))).json();
  assert.notEqual(ticket.ticket,'raw-worker-ticket');
  const archived=await request('/api/workspace/projects/'+p.id+'/trash','POST',{operationId:'op-trash',expectedRevision:p.revision});assert.equal(archived.status,200);
  assert.deepEqual(await (await request('/v1/projects')).json(),[]);
  assert.deepEqual(await (await request('/session?directory='+encodeURIComponent(project.path))).json(),[]);
  assert.equal((await request('/session/ses_a')).status,409);
  const lifecycle=await request('/api/workspace/sessions/ses_a/state');assert.equal(lifecycle.status,200);assert.equal((await lifecycle.json()).state,'trashed');
  assert.equal((await request('/v1/fs/read?ticket='+ticket.ticket)).status,409);assert.equal(upstreamReads,0);
  assert.equal((await request('/v1/projects/'+p.id,'DELETE',{})).status,409);
  assert.equal((await request('/v1/projects/'+p.id,'PATCH',{name:'Changed through old route'})).status,409);
  assert.equal(project.name,'A');
  await assert.rejects(server.collaboration.applyPermissions({userId:worker.userId,directory:project.path,sessionId:'ses_a',runtime:'opencode'},'guided'),{code:'project_trashed'});
  assert.equal((await request('/api/workspace/trash/'+p.id+'/restore','POST',{operationId:'op-restore'})).status,200);
  assert.equal((await (await request('/v1/projects')).json())[0].path,project.path);
  assert.equal(payload,'retained bytes');
  for(const mode of ['declared','streamed','malformed','encoding'])await t.test('bounded upstream JSON: '+mode,async()=>{
    projectResponse=mode;
    const response=await request('/api/workspace/projects');assert.equal(response.status,503);
    assert.equal((await response.json()).code,mode==='declared'||mode==='streamed'?'workspace_response_limit':'workspace_response_invalid');
    if(mode==='streamed'){const sent=chunksSent;await new Promise(done=>setTimeout(done,30));assert.equal(chunksSent,sent);assert.ok(chunksSent<=66);}
  });
  projectResponse='normal';assert.equal((await request('/api/workspace/projects')).status,200);
  await t.test('legacy project creation retains account admission until the worker finishes',async()=>{
    let started;const ready=new Promise(done=>{started=done;});createStarted=started;
    const creating=request('/v1/projects','POST',{name:'New project'});await ready;
    let renamed=false;const originalName=project.name;
    const renaming=request('/api/workspace/projects/'+project.id,'PATCH',{name:'After create',operationId:'after-create'}).then(response=>{renamed=true;return response;});
    let responses;
    try{await new Promise(done=>setTimeout(done,50));assert.equal(renamed,false);assert.equal(project.name,originalName);}
    finally{releaseCreate();responses=await Promise.all([creating,renaming]);}
    assert.equal(responses[0].status,200);assert.equal(responses[1].status,200);assert.equal(project.name,'After create');
  });
  await t.test('disconnect does not release admission while a legacy worker mutation continues',async()=>{
    let started;const ready=new Promise(done=>{started=done;});createStarted=started;
    const controller=new AbortController();
    const creating=fetch(base+'/v1/projects',{method:'POST',signal:controller.signal,headers:{cookie,origin:base,'content-type':'application/json','x-scikeel-runtime-generation':'1'},body:JSON.stringify({name:'Disconnected'})}).catch(error=>error);
    await ready;controller.abort();await creating;
    let renamed=false;const originalName=project.name;
    const renaming=request('/api/workspace/projects/'+project.id,'PATCH',{name:'After disconnect',operationId:'after-disconnect'}).then(response=>{renamed=true;return response;});
    try{await new Promise(done=>setTimeout(done,50));assert.equal(renamed,false);assert.equal(project.name,originalName);}
    finally{releaseCreate();await renaming;}
    assert.equal(project.name,'After disconnect');
  });
  await t.test('pending file recovery blocks new work but never blocks an authorized stop',async()=>{
    server.workspaceFiles={confirmPending:async()=>{throw workspaceError('operation_pending');}};
    const starting=await request('/session','POST',{});assert.equal(starting.status,409);assert.equal((await starting.json()).code,'operation_pending');
    const stopping=await request('/session/ses_a/abort','POST',{});assert.equal(stopping.status,200);assert.equal(await stopping.json(),true);
  });
});
