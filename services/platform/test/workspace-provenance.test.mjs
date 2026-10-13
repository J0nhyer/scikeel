import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {WorkspaceProvenance}=await import('../src/workspace-provenance.mjs').catch(()=>({}));
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 assert.equal(typeof WorkspaceProvenance,'function','Manual workspace mutations require bounded idempotent provenance');
 const payloads=new Map();let writes=0,loseReply=false;
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path);
  if(request.operation==='mkdirAll')return {};
  if(request.operation==='readChunk')return {bytes:[...entry.subarray(request.offset,request.offset+request.limit)],size:entry.length};
  if(request.operation==='writeChunk'){
   if((entry?.length??0)!==request.offset || (request.offset===0 && entry))throw new Error('concurrent append');
   payloads.set(request.path,Buffer.concat([entry??Buffer.alloc(0),Buffer.from(request.bytes)]));writes++;if(loseReply){loseReply=false;throw new Error('lost history reply');}return {};
  }
  throw new Error('unexpected operation');
 }};
 const stat=async(_context,path)=>payloads.has(path)?{identity:'inode-'+path,revision:hash(payloads.get(path)),size:payloads.get(path).length,isDir:false}:null;
 const files={native,stat};const history=new WorkspaceProvenance({files,clock:()=>1000000});
 const context={userId:'a',instanceId:'user-a',generation:1};
 const record={input:{kind:'file',scope:{kind:'project',projectId:'123456789abcdef0'},operation:{kind:'rename',path:'source.txt',destinationPath:'renamed.txt',expectedRevision:'a'.repeat(64)}},receipt:{operationId:'rename-a',state:'committed',result:{path:'renamed.txt',identity:'owned',revision:'b'.repeat(64)}},recovery:{source:'projects/study/source.txt',destination:'projects/study/renamed.txt'}};
 return {history,context,record,payloads,files,writes:()=>writes,lose:()=>loseReply=true};
}
test('manual changes append the existing versioned schema without file contents or credentials',async()=>{
 const f=fixture();await f.history.record(f.context,'rename-a',f.record);
 const text=f.payloads.get('projects/study/.openscience/provenance.jsonl').toString(),record=JSON.parse(text);
 assert.equal(record.path,'renamed.txt');assert.equal(record.version,1);assert.equal(record.ts,1000);assert.equal(record.tool,'manual:rename');assert.equal(record.content,undefined);
 const log=JSON.parse(record.log);assert.equal(log.operationId,'rename-a');assert.equal(log.sourcePath,'source.txt');assert.equal(log.destinationPath,'renamed.txt');assert.equal(log.revision,'b'.repeat(64));assert.equal(text.includes('/owned'),false);
});
test('a lost history append response retries only history and does not duplicate a version',async()=>{
 const f=fixture();f.lose();await assert.rejects(f.history.record(f.context,'rename-a',f.record));
 await f.history.record(f.context,'rename-a',f.record);assert.equal(f.writes(),1);
 f.record.receipt.operationId='rename-b';await f.history.record(f.context,'rename-b',f.record);assert.equal(f.writes(),2);
 const lines=f.payloads.get('projects/study/.openscience/provenance.jsonl').toString().trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(lines.map(line=>line.version),[1,2]);
});
test('bounded scanning refuses a corrupt or oversized history store without replacing it',async()=>{
 const f=fixture(),path='projects/study/.openscience/provenance.jsonl';f.payloads.set(path,Buffer.from('{broken\n'));
 await assert.rejects(f.history.record(f.context,'rename-a',f.record));assert.equal(f.payloads.get(path).toString(),'{broken\n');assert.equal(f.writes(),0);
 f.payloads.set(path,Buffer.alloc(8*1024**2+1));await assert.rejects(f.history.record(f.context,'rename-a',f.record));assert.equal(f.writes(),0);
});
test('uncommitted and untrusted reconstruction cannot append manual provenance',async()=>{
 const f=fixture();await assert.rejects(f.history.record(f.context,'rename-a',{...f.record,receipt:{state:'pending'}}));
 await assert.rejects(f.history.record(f.context,'rename-a',{...f.record,recovery:{source:'.scikeel/private/source.txt',destination:'projects/study/renamed.txt'}}));assert.equal(f.writes(),0);
});
test('long allowed source and destination names still deduplicate a lost history append',async()=>{
 const f=fixture(),source=Array(16).fill('a'.repeat(240)).join('/')+'/'+ 's'.repeat(215)+'.txt',destination=Array(16).fill('b'.repeat(240)).join('/')+'/'+ 'd'.repeat(215)+'.txt';
 f.record.input.operation.path=source;f.record.input.operation.destinationPath=destination;f.record.recovery={source:'projects/study/'+source,destination:'projects/study/'+destination};f.lose();
 await assert.rejects(f.history.record(f.context,'rename-a',f.record));await f.history.record(f.context,'rename-a',f.record);assert.equal(f.writes(),1);
});
