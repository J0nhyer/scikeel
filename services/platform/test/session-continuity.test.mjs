import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { TenantPolicy }=await import('../src/tenant-policy.mjs');
const { PlatformServer }=await import('../src/platform-server.mjs');
const { CollaborationStore }=await import('../src/collaboration.mjs');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'scikeel-continuity-probe-'));
 const user={id:'diagnostic',role:'user'};
 let generation=1,reverts=0,frames=0,replies=0,missing=false,replyGate;
 const logs=[];const replyDirectories=[];
 const context=()=>({userId:user.id,instanceId:'user-diagnostic',generation,workspaceDir:'/owned/science'});
 const session={id:'ses_diagnostic',directory:'/owned/science'};
 const policy=new TenantPolicy({accounts:[context()]});
 policy.registerSession(context(),session);
 const sockets=new Set();
 const upstream=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  if(path==='/event'){
   res.writeHead(200,{'content-type':'text/event-stream'});
   const send=()=>{frames++;res.write('data: {"type":"server.heartbeat","properties":{}}\n\n');};
   send();const timer=setInterval(send,250);res.once('close',()=>clearInterval(timer));return;
  }
  res.setHeader('content-type','application/json');
  if(path==='/question'){res.end(JSON.stringify(missing?[]:[{id:'question_live',sessionID:session.id,questions:[]} ]));return;}
  if(path==='/question/question_live/reply'){
    replies++;if(replyGate)await replyGate;replyDirectories.push(new URL(req.url,'http://fixture.invalid').searchParams.get('directory'));
    if(missing){res.statusCode=400;res.end(JSON.stringify({name:'QuestionNotFoundError',data:{message:'Question is no longer pending'}}));return;}
    res.end('true');return;
  }
  if(path==='/session' || path==='/experimental/session'){res.end(JSON.stringify([session]));return;}
  if(path==='/session/ses_diagnostic/revert'){
    reverts++;let raw='';for await(const chunk of req)raw+=chunk;
    session.revert={messageID:JSON.parse(raw).messageID};res.end('true');return;
  }
  if(path==='/session/ses_diagnostic/message'){
    res.end(JSON.stringify([{info:{id:'msg_before',sessionID:session.id,role:'user'},parts:[{type:'text',text:'Before revert'}]},
      {info:{id:'msg_diagnostic',sessionID:session.id,role:'user'},parts:[{type:'text',text:'Reverted message'}]}]));return;
  }
  if(path==='/session/ses_diagnostic'){res.end(JSON.stringify(session));return;}
  res.end('{}');
 });
 upstream.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const access={url:`http://127.0.0.1:${upstream.address().port}`,token:'diagnostic-fixture-token'};
 const manager={rootDir:join(root,'workers'),init:async()=>{},ensureWorker:async()=>{},
  getWorker:()=>({id:'user-diagnostic',userId:user.id,status:'running',generation,workspaceDir:'/owned/science'}),
  getWorkerAccess:()=>access};
 const authStore={init:async()=>{},getUserBySession:async()=>user};
 const server=new PlatformServer({host:'127.0.0.1',port:0,authStore,workerManager:manager,tenantPolicy:policy,logger:event=>logs.push(event)});
 const address=await server.listen();const origin=`http://127.0.0.1:${address.port}`;
 t.after(async()=>{await server.close();for(const s of sockets)s.destroy();await new Promise(resolve=>upstream.close(resolve));await rm(root,{recursive:true,force:true});});
 const request=(path,init={})=>fetch(origin+path,{...init,headers:{cookie:'osd_session=fixture',origin,'content-type':'application/json',...init.headers},signal:init.signal ?? AbortSignal.timeout(35000)});
 return {request,policy,context,rotate:()=>{generation++;policy.registerAccount(context());},reverts:()=>reverts,frames:()=>frames,replies:()=>replies,logs,replyDirectories,expire:()=>{missing=true;},holdReply:()=>{let release;replyGate=new Promise(done=>{release=()=>{replyGate=undefined;done();};});return release;}};
}
test('persisted owned session rebinds current-generation authority before a revert mutation',async t=>{
 const f=await fixture(t);const init={method:'POST',body:JSON.stringify({messageID:'msg_diagnostic'})};
 assert.equal((await f.request('/session/ses_diagnostic/revert',init)).status,200);
 assert.equal(f.reverts(),1);f.rotate();
 const recovered=await f.request('/session/ses_diagnostic/revert',init);
 assert.equal(recovered.status,200);
 assert.equal(f.reverts(),2,'exactly one upstream mutation after authority recovery');

});
test('accepted execution survives closing the last browser beyond its presence expiry',async t=>{
 const root=await mkdtemp(join(tmpdir(),'scikeel-lease-probe-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let now=1000,cancels=0;
 const store=new CollaborationStore({rootDir:root,now:()=>now,cancel:async()=>{cancels++;}});
 const owner={userId:'diagnostic',sessionId:'ses_diagnostic',runtime:'opencode',directory:'/owned/science',workspaceDir:'/owned/science'};
 await store.heartbeat(owner,'page-diagnostic');const initial=await store.get(owner);await store.begin(owner,initial.revision);
 await store.release(owner,'page-diagnostic');now+=46000;await store.tick();
 assert.equal((await store.get(owner)).phase,'running');assert.equal(cancels,0);
});
test('diagnostic: healthy SSE survives the gateway deadline and ends only at the diagnostic client deadline',{timeout:38000},async t=>{
 const f=await fixture(t);const start=performance.now();const response=await f.request('/event');
 assert.equal(response.status,200);const reader=response.body.getReader();let interrupted=false;let interruption;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;}}catch(error){interrupted=true;interruption=error;}
 const elapsed=performance.now()-start;
 assert.equal(interrupted,true);assert.equal(interruption.name,'TimeoutError');assert.ok(elapsed>=34000 && elapsed<37500,`elapsed=${elapsed}`);assert.ok(f.frames()>100);
 console.log(JSON.stringify({healthySseObservedUntilClientDeadlineMs:Math.round(elapsed),frames:f.frames()}));
});

test('current pending question recovers after registry generation changes, with no duplicate mutation',async t=>{
 const f=await fixture(t);f.rotate();
 const result=await f.request('/question/question_live/reply',{method:'POST',body:JSON.stringify({answers:[['sentinel-answer-text']]})});
 assert.equal(result.status,200);assert.equal(result.headers.get('x-scikeel-runtime-generation'),'2');
 assert.equal(f.replies(),1);assert.deepEqual(f.replyDirectories,['/owned/science']);
 assert.equal(JSON.stringify(f.logs).includes('sentinel-answer-text'),false);
 assert.equal(JSON.stringify(f.logs).includes('diagnostic-fixture-token'),false);
});
test('native expired question retains HTTP status and name; a durable session remains revertible',async t=>{
 const f=await fixture(t);f.policy.registerRequest(f.context(),{id:'question_live',sessionID:'ses_diagnostic'});f.expire();
 const result=await f.request('/question/question_live/reply',{method:'POST',body:JSON.stringify({answers:[['A']]})});
 assert.equal(result.status,400);assert.equal((await result.json()).name,'QuestionNotFoundError');
 assert.equal((await f.request('/session/ses_diagnostic/revert',{method:'POST',body:JSON.stringify({messageID:'msg_diagnostic'})})).status,200);
});
test('runtime description exposes safe current context without access secrets',async t=>{
 const f=await fixture(t);const value=await (await f.request('/api/runtime')).json();
 assert.deepEqual(value.context,{instanceId:'user-diagnostic',generation:1});
 assert.equal(JSON.stringify(value).includes('diagnostic-fixture-token'),false);
});

test('concurrent browser retransmissions submit a question only once',async t=>{
 const f=await fixture(t);const release=f.holdReply();const init={method:'POST',body:JSON.stringify({answers:[['A']]})};
 const one=f.request('/question/question_live/reply',init);const two=f.request('/question/question_live/reply',init);
 for(let attempts=0;attempts<100 && f.replies()<1;attempts++)await new Promise(done=>setTimeout(done,5));
 assert.equal(f.replies(),1);release();
 assert.equal((await one).status,200);assert.equal((await two).status,200);assert.equal(f.replies(),1);
 assert.equal((await f.request('/question/question_live/reply',{...init,body:JSON.stringify({answers:[['B']]})})).status,409);
 assert.equal(f.replies(),1);
});
test('a disconnected page cannot cancel an accepted reply; its retry receives the same receipt',async t=>{
 const f=await fixture(t);const release=f.holdReply();const controller=new AbortController();
 const init={method:'POST',body:JSON.stringify({answers:[['A']]})};
 const first=f.request('/question/question_live/reply',{...init,signal:controller.signal}).catch(error=>error);
 for(let attempts=0;attempts<100 && f.replies()<1;attempts++)await new Promise(done=>setTimeout(done,5));
 controller.abort();await first;release();
 assert.equal((await f.request('/question/question_live/reply',init)).status,200);assert.equal(f.replies(),1);
});

test('reopened history honors the native revert marker instead of restoring reverted messages',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/session/ses_diagnostic/revert',{method:'POST',body:JSON.stringify({messageID:'msg_diagnostic'})})).status,200);
 f.rotate();
 const response=await f.request('/session/ses_diagnostic/message');assert.equal(response.status,200);
 assert.deepEqual((await response.json()).map(message=>message.info.id),['msg_before']);
});
