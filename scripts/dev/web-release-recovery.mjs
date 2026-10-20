import {mkdir,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {freezeSource,validateCandidate,inventorySource,fingerprintFiles,sha256} from './web-release-source.mjs';
import {readManifest,writeManifest} from './web-release-state.mjs';
import {assistantTargetHash} from './web-assistant-release.mjs';

const checks=['exclusive_selection','native_history','canonical_bindings','continued_write','workspace_preserved'];
function validateProof(proof) {
 if(proof?.schema!==1||proof.status!=='passed'||!Number.isSafeInteger(proof.runtimeVersion)||proof.runtimeVersion<1||
  !Number.isSafeInteger(proof.conversationSchema)||proof.conversationSchema<1||JSON.stringify(proof.checks)!==JSON.stringify(checks))
  throw Error('Compatible reader persistence proof is incomplete');
}
function recoveryDirectory(candidate) {
 const id=`${candidate.id}-reader`;
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||!candidate.sharedStore)throw Error('Unsafe compatible recovery identity');
 return {id,directory:join(resolve(candidate.sharedStore),'web-releases',id)};
}
export async function loadCompatibleRecovery(candidate,{validate=validateCandidate}={}) {
 const {id,directory}=recoveryDirectory(candidate),record=candidate.compatibleRecovery;
 if(record?.schema!==1||record.id!==id||record.directory!==directory||record.manifestHash!==await sha256(join(directory,'manifest.json')))
  throw Error('Compatible recovery manifest is unavailable or changed');
 const reader=await readManifest(join(directory,'manifest.json'));
 if(reader.kind!=='assistant-forward-reader'||reader.status!=='recovery-prepared'||reader.id!==id||reader.directory!==directory||
  reader.recoveryFor!==candidate.id||reader.source.root!==join(directory,'source')||
  reader.source.fingerprint!==candidate.source.fingerprint||reader.baseline.fingerprint!==candidate.baseline.fingerprint||
  reader.artifacts.image.imageDigest!==candidate.artifacts.image.imageDigest||
  reader.assistantTargetHash!==assistantTargetHash(candidate.assistantTarget)||
  reader.artifacts.web.directory!==join(directory,'web')||reader.artifacts.web.fingerprint!==candidate.artifacts.web.fingerprint)
  throw Error('Compatible recovery reader or target identity changed');
 validateProof(reader.readerProof);
 await validate(reader);
 if(fingerprintFiles(await inventorySource(reader.artifacts.web.directory,{git:false}))!==reader.artifacts.web.fingerprint)
  throw Error('Retained recovery Web artifacts changed');
 return reader;
}
export async function prepareCompatibleRecovery(candidate,{freeze=freezeSource,validate=validateCandidate,verifyReader}={}) {
 const {id,directory}=recoveryDirectory(candidate);
 if(candidate.compatibleRecovery) {
  await loadCompatibleRecovery(candidate,{validate});return candidate.compatibleRecovery;
 }
 if(!candidate.artifacts.web?.directory||!candidate.artifacts.web.fingerprint)throw Error('A checked compatible Web bundle is required for recovery');
 const disk=await statfs(candidate.sharedStore),needed=[...candidate.source.files,...candidate.artifacts.web.files]
  .reduce((sum,file)=>sum+(file.bytes??0),0)+128*1024**2;
 if(disk.bavail*disk.bsize<needed)throw Error('Insufficient disk space for compatible recovery source');
 await mkdir(directory,{mode:0o700});
 const sourceRoot=join(directory,'source');
 const views=await freeze(candidate.source.root,sourceRoot,candidate.source.files,{dependencies:candidate.source.dependencies});
 const source={...structuredClone(candidate.source),root:sourceRoot,views};
 await validate({source});
 if(!verifyReader) {
  const fixture=await import(pathToFileURL(join(sourceRoot,'services/platform/fixtures/assistant-rollback-reader.mjs')));
  verifyReader=fixture.verifyAssistantRollbackReader;
 }
 const proof=await verifyReader({sourceRoot,writerSourceRoot:candidate.source.root});validateProof(proof);
 const files=await inventorySource(candidate.artifacts.web.directory,{git:false});
 if(fingerprintFiles(files)!==candidate.artifacts.web.fingerprint)throw Error('Compatible recovery Web artifacts changed');
 const web=join(directory,'web');
 await freezeSource(candidate.artifacts.web.directory,web,files,{linkDependencies:false});
 const reader={schema:1,id,directory,status:'recovery-prepared',kind:'assistant-forward-reader',recoveryFor:candidate.id,
  source,baseline:structuredClone(candidate.baseline),assistantTargetHash:assistantTargetHash(candidate.assistantTarget),
  stages:{'reader-persistence':{status:'passed'}},readerProof:proof,
  artifacts:{image:structuredClone(candidate.artifacts.image),web:{directory:web,files,fingerprint:fingerprintFiles(files)}}};
 await writeManifest(join(directory,'manifest.json'),reader);
 return {schema:1,id,directory,manifestHash:await sha256(join(directory,'manifest.json'))};
}
export function compatibleRecoveryPrevious(previous,reader) {
 const platform=reader.source.files.filter(file=>file.path.startsWith('services/platform/src/'))
  .map(file=>({...file,path:file.path.slice('services/platform/src/'.length)}));
 return {...previous,originalProduction:previous.production,originalPointer:previous.pointer,originalSourceBackup:previous.sourceBackup,
  production:{...previous.production,source:reader.source.root,platformFingerprint:fingerprintFiles(platform),
   imageDigest:reader.artifacts.image.imageDigest,webRoot:reader.artifacts.web.directory,webFingerprint:reader.artifacts.web.fingerprint},
  sourceBackup:reader.source,files:reader.artifacts.web.files,
  pointer:{id:reader.id,previousId:previous.pointer?.id??null},recoveryReader:{id:reader.id,directory:reader.directory}};
}
export async function markCompatibleRecoveryRestored(previous,production) {
 if(!previous.recoveryReader)return;
 const {id,directory}=previous.recoveryReader;
 const reader=await readManifest(join(directory,'manifest.json'));
 if(reader.id!==id||reader.kind!=='assistant-forward-reader'||reader.source.fingerprint!==previous.sourceBackup.fingerprint)
  throw Error('Compatible recovery record changed');
 reader.status='published';reader.deployment={production,verifiedAt:new Date().toISOString(),recovery:true};
 await writeManifest(join(directory,'manifest.json'),reader);
 previous.pointer.manifestHash=await sha256(join(directory,'manifest.json'));
}
