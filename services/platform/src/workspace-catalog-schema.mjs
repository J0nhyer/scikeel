import {createHash} from 'node:crypto';

export const catalogError=(code,statusCode=503)=>Object.assign(new Error(code.replaceAll('_',' ')),{code,statusCode});
export const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,511}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function validateChange(change) {
 const keys=['changeId','userId','source','sourceKey','sourceRevision','projectUpserts','conversationUpserts','projectTombstones','conversationTombstones'];
 if(!exact(change,keys)||!identifier(change.changeId)||!identifier(change.userId)||!identifier(change.sourceKey)||
  !['canonical','workspace','cli'].includes(change.source)||!integer(change.sourceRevision)||change.sourceRevision<1||
  keys.slice(5).some(key=>!Array.isArray(change[key])||change[key].length>20000))throw catalogError('invalid_catalog_change');
 for(const row of change.projectUpserts) {
  if(!record(row)||Object.keys(row).some(key=>!['id','directoryRef','name','lifecycle','sourceRevision','createdAt','pinned','imported'].includes(key))||!identifier(row.id)||!identifier(row.directoryRef)||
   row.createdAt!==undefined&&!integer(row.createdAt)||row.pinned!==undefined&&typeof row.pinned!=='boolean'||row.imported!==undefined&&typeof row.imported!=='boolean'||
   !text(row.name,4096)||!['active','trashed'].includes(row.lifecycle)||!integer(row.sourceRevision))throw catalogError('invalid_catalog_change');
 }
 for(const row of change.conversationUpserts) {
  if(!exact(row,['id','projectId','directoryRef','title','parentId','runtime','lifecycle','updatedAt','sourceRef','sourceRevision'])||
   !identifier(row.id)||row.projectId!==null&&!identifier(row.projectId)||!identifier(row.directoryRef)||!text(row.title,4096)||
   row.parentId!==null&&!identifier(row.parentId)||!['codex','claude','opencode'].includes(row.runtime)||
   !['active','archived','trashed'].includes(row.lifecycle)||!integer(row.updatedAt)||!identifier(row.sourceRef)||!integer(row.sourceRevision))throw catalogError('invalid_catalog_change');
 }
 if([...change.projectTombstones,...change.conversationTombstones].some(value=>!identifier(value)))throw catalogError('invalid_catalog_change');
 for(const key of ['projectUpserts','conversationUpserts'])if(new Set(change[key].map(row=>row.id)).size!==change[key].length)throw catalogError('invalid_catalog_change');
 if(Buffer.byteLength(JSON.stringify(change))>16*1024**2)throw catalogError('catalog_change_too_large',507);
 return change;
}

export const schema=`
CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY,catalog_revision INTEGER NOT NULL DEFAULT 0,import_state TEXT NOT NULL DEFAULT 'pending',source_revision_digest TEXT);
CREATE TABLE IF NOT EXISTS projects(user_id TEXT NOT NULL,id TEXT NOT NULL,directory_ref TEXT NOT NULL,lifecycle TEXT NOT NULL,source_key TEXT NOT NULL,source_revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE IF NOT EXISTS conversations(user_id TEXT NOT NULL,id TEXT NOT NULL,directory_ref TEXT NOT NULL,lifecycle TEXT NOT NULL,updated_at INTEGER NOT NULL,source TEXT NOT NULL,source_key TEXT NOT NULL,source_revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(user_id,lifecycle,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_directory_recent ON conversations(user_id,directory_ref,lifecycle,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS applied_changes(user_id TEXT NOT NULL,change_id TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(user_id,change_id));
CREATE TABLE IF NOT EXISTS source_revisions(user_id TEXT NOT NULL,source_key TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(user_id,source_key));
CREATE TABLE IF NOT EXISTS import_checkpoints(user_id TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,source));
CREATE TABLE IF NOT EXISTS directories(user_id TEXT NOT NULL,directory_ref TEXT NOT NULL,relative_path TEXT NOT NULL,PRIMARY KEY(user_id,directory_ref));
PRAGMA user_version=1;`;
