import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('the recovery reader preserves new selection, native history, bindings and workspace bytes across a continued write',async()=>{
 const {verifyAssistantRollbackReader}=await import('../fixtures/assistant-rollback-reader.mjs');
 const sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
 const proof=await verifyAssistantRollbackReader({sourceRoot});
 assert.equal(proof.status,'passed');assert.equal(proof.schema,1);
 assert.equal(proof.runtimeVersion,5);assert.equal(proof.conversationSchema,2);
 assert.deepEqual(proof.checks,['exclusive_selection','native_history','canonical_bindings','continued_write','workspace_preserved']);
});

test('an unavailable or incompatible recovery module cannot produce a passing reader proof',async t=>{
 const {verifyAssistantRollbackReader}=await import('../fixtures/assistant-rollback-reader.mjs');
 const sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
 const reader=await mkdtemp(join(tmpdir(),'scikeel-incompatible-reader-'));
 t.after(()=>rm(reader,{recursive:true,force:true}));
 await assert.rejects(verifyAssistantRollbackReader({sourceRoot:reader,writerSourceRoot:sourceRoot}));
 await mkdir(join(reader,'services/platform/src'),{recursive:true});
 await writeFile(join(reader,'services/platform/src/cli-runtime.mjs'),'export class CliRuntimeManager { constructor(){throw Error("Unsupported runtime storage");} }');
 await writeFile(join(reader,'services/platform/src/conversation-state.mjs'),'export class ConversationState {}');
 await assert.rejects(verifyAssistantRollbackReader({sourceRoot:reader,writerSourceRoot:sourceRoot}));
});
