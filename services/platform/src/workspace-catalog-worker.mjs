import Database from 'better-sqlite3';
import {parentPort,workerData} from 'node:worker_threads';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {schema,catalogError,identifier,digest,validateChange} from './workspace-catalog-schema.mjs';

const db=new Database(workerData.path);
db.pragma('journal_mode=DELETE');db.pragma('synchronous=FULL');db.pragma('foreign_keys=ON');
db.pragma('temp_store=MEMORY');db.pragma('cache_size=-4096');db.pragma('busy_timeout=50');
if(![0,1].includes(db.pragma('user_version',{simple:true})))throw catalogError('catalog_schema_unavailable');
db.exec(schema);
const account=userId=>{if(!identifier(userId))throw catalogError('invalid_catalog_query',400);return db.prepare('SELECT * FROM accounts WHERE user_id=?').get(userId);};
const revision=userId=>{const row=account(userId);if(row?.import_state!=='ready')throw catalogError('catalog_recovering');return row.catalog_revision;};
const apply=db.transaction(change=>{
 validateChange(change);const hash=digest(change),{userId,changeId,sourceKey,sourceRevision}=change;
 const previous=db.prepare('SELECT payload_hash,revision FROM applied_changes WHERE user_id=? AND change_id=?').get(userId,changeId);
 if(previous){if(previous.payload_hash!==hash)throw catalogError('catalog_change_conflict');return {revision:previous.revision};}
 db.prepare('INSERT OR IGNORE INTO accounts(user_id) VALUES (?)').run(userId);
 const source=db.prepare('SELECT revision FROM source_revisions WHERE user_id=? AND source_key=?').get(userId,sourceKey);
 if(source&&sourceRevision<=source.revision)throw catalogError('catalog_source_conflict');
 for(const row of change.projectUpserts)db.prepare('INSERT OR REPLACE INTO projects VALUES (?,?,?,?,?,?,?)').run(userId,row.id,row.directoryRef,row.lifecycle,sourceKey,row.sourceRevision,JSON.stringify(row));
 for(const row of change.conversationUpserts){
  const current=db.prepare('SELECT source,source_key FROM conversations WHERE user_id=? AND id=?').get(userId,row.id);
  if(current?.source==='canonical'&&change.source!=='canonical')continue;
  if(current&&current.source!=='canonical'&&change.source!=='canonical'&&current.source_key!==sourceKey&&current.source_key!==`import/${sourceKey}`)throw catalogError('catalog_origin_conflict');
  db.prepare('INSERT OR REPLACE INTO conversations VALUES (?,?,?,?,?,?,?,?,?)').run(userId,row.id,row.directoryRef,row.lifecycle,row.updatedAt,change.source,sourceKey,row.sourceRevision,JSON.stringify(row));
 }
 for(const id of change.projectTombstones)db.prepare('DELETE FROM projects WHERE user_id=? AND id=? AND source_key IN (?,?)').run(userId,id,sourceKey,`import/${sourceKey}`);
 for(const id of change.conversationTombstones)db.prepare('DELETE FROM conversations WHERE user_id=? AND id=? AND source_key IN (?,?)').run(userId,id,sourceKey,`import/${sourceKey}`);
 db.prepare('INSERT OR REPLACE INTO source_revisions VALUES (?,?,?)').run(userId,sourceKey,sourceRevision);
 db.prepare('UPDATE accounts SET catalog_revision=catalog_revision+1 WHERE user_id=?').run(userId);
 const next=account(userId).catalog_revision;
 db.prepare('INSERT INTO applied_changes VALUES (?,?,?,?)').run(userId,changeId,hash,next);
 return {revision:next};
});
const sign=payload=>createHmac('sha256',workerData.cursorKey).update(payload).digest('base64url');
function cursorEncode(value){const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return `${payload}.${sign(payload)}`;}
function cursorDecode(cursor,scope,revision){
 if(typeof cursor!=='string'||cursor.length>4096)throw catalogError('invalid_catalog_cursor',400);
 const [payload,signature,...extra]=cursor.split('.');const expected=sign(payload??'');
 if(extra.length||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw catalogError('invalid_catalog_cursor',400);
 let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw catalogError('invalid_catalog_cursor',400);}
 if(!data||data.scope!==scope||!Array.isArray(data.last))throw catalogError('invalid_catalog_cursor',400);
 if(data.revision!==revision)throw catalogError('catalog_revision_changed',409);
 return data.last;
}
function page(kind,{userId,limit=50,cursor=null,directoryRef=null,lifecycle='active'}) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||directoryRef!==null&&!identifier(directoryRef)||!['active','archived','trashed'].includes(lifecycle))throw catalogError('invalid_catalog_query',400);
 const rev=revision(userId),scope=digest([userId,kind,limit,directoryRef,lifecycle]),last=cursor===null?null:cursorDecode(cursor,scope,rev);
 let rows;
 if(kind==='projects'){
  if(last&&(last.length!==1||!identifier(last[0])))throw catalogError('invalid_catalog_cursor',400);
  rows=db.prepare(`SELECT id,payload FROM projects WHERE user_id=? AND lifecycle=? ${last?'AND id>?':''} ORDER BY id LIMIT ?`).all(userId,lifecycle,...last??[],limit+1);
 }else{
  if(last&&(last.length!==2||!Number.isSafeInteger(last[0])||last[0]<0||!identifier(last[1])))throw catalogError('invalid_catalog_cursor',400);
  rows=db.prepare(`SELECT id,updated_at,payload FROM conversations WHERE user_id=? ${directoryRef?'AND directory_ref=?':''} AND lifecycle=? ${last?'AND (updated_at,id)<(?,?)':''} ORDER BY updated_at DESC,id DESC LIMIT ?`)
   .all(userId,...directoryRef?[directoryRef]:[],lifecycle,...last??[],limit+1);
 }
 const hasMore=rows.length>limit;rows=rows.slice(0,limit);const tail=rows.at(-1);
 const items=rows.map(row=>JSON.parse(row.payload)),directoryPaths={};
 for(const ref of new Set(items.map(row=>row.directoryRef))){
  const owned=db.prepare('SELECT relative_path FROM directories WHERE user_id=? AND directory_ref=?').get(userId,ref);
  if(owned)directoryPaths[ref]=owned.relative_path;
 }
 return {items,nextCursor:hasMore?cursorEncode({scope,revision:rev,last:kind==='projects'?[tail.id]:[tail.updated_at,tail.id]}):null,revision:rev,directoryPaths};
}
const operations={
 ping:()=>true,apply:({change})=>apply(change),
 directories:db.transaction(({userId,directories})=>{
  account(userId);
  if(!Array.isArray(directories)||directories.length>30000)throw catalogError('invalid_catalog_change');
  for(const {directoryRef,relativePath} of directories){
   if(!identifier(directoryRef)||typeof relativePath!=='string'||relativePath.length>4096||relativePath.startsWith('/')||relativePath.split('/').some(part=>['..','.'].includes(part))||/[\\\0]/.test(relativePath))throw catalogError('invalid_catalog_change');
   const old=db.prepare('SELECT relative_path FROM directories WHERE user_id=? AND directory_ref=?').get(userId,directoryRef);
   if(old&&old.relative_path!==relativePath)throw catalogError('catalog_origin_conflict');
   db.prepare('INSERT OR IGNORE INTO directories VALUES (?,?,?)').run(userId,directoryRef,relativePath);
  }return true;
 }),
 verify:({userId,sourceDigest})=>{account(userId);if(!/^[a-f0-9]{64}$/.test(sourceDigest??''))throw catalogError('invalid_catalog_change');db.prepare("INSERT INTO accounts(user_id,import_state,source_revision_digest) VALUES (?,'ready',?) ON CONFLICT(user_id) DO UPDATE SET import_state='ready',source_revision_digest=excluded.source_revision_digest").run(userId,sourceDigest);return true;},
 checkpoint:({userId,source,payload})=>{account(userId);if(!identifier(source)||Buffer.byteLength(JSON.stringify(payload))>65536)throw catalogError('invalid_catalog_change');db.prepare('INSERT OR REPLACE INTO import_checkpoints VALUES (?,?,?)').run(userId,source,JSON.stringify(payload));return true;},
 conversations:args=>page('conversations',args),projects:args=>page('projects',args),
 conversation:({userId,id})=>{revision(userId);if(!identifier(id))throw catalogError('invalid_catalog_query',400);const row=db.prepare('SELECT payload FROM conversations WHERE user_id=? AND id=?').get(userId,id);return row?JSON.parse(row.payload):null;},
 snapshot:db.transaction(args=>({projects:page('projects',{...args,limit:100}),conversations:page('conversations',args),revision:revision(args.userId)})),
 queryPlans:()=>[
  ...db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM conversations WHERE user_id='a' AND lifecycle='active' ORDER BY updated_at DESC,id DESC LIMIT 50").all(),
  ...db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM conversations WHERE user_id='a' AND directory_ref='d' AND lifecycle='active' ORDER BY updated_at DESC,id DESC LIMIT 50").all(),
 ].map(row=>row.detail),close:()=>{db.close();return true;},
};
parentPort.on('message',({id,operation,args})=>{
 try{if(!Object.hasOwn(operations,operation))throw catalogError('invalid_catalog_operation');parentPort.postMessage({id,value:operations[operation](args)});}
 catch(error){parentPort.postMessage({id,error:{code:error.code?.startsWith('catalog_')||error.code?.startsWith('invalid_catalog_')?error.code:'catalog_storage_unavailable',statusCode:error.statusCode??503}});}
});
