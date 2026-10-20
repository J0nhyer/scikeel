import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,writeFile,mkdir,rm,chmod,rename} from 'node:fs/promises';
import {join} from 'node:path';

// Real temporary file bytes with an injected RPC boundary; not a native binary proof.
export function localRevertFiles({workspaceDir,record=()=>{},beforeRestore=async()=>{},afterRestore=async()=>{}}){
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const stat=async path=>{try{
  const value=await lstat(path,{bigint:true});
  if(value.isSymbolicLink()||value.isFile()&&value.nlink!==1n)throw Error('unsafe link');
  return {identity:digest(`${value.dev}:${value.ino}`),revision:digest(`${value.dev}:${value.ino}:${value.size}:${value.mode}:${value.mtimeNs}:${value.ctimeNs}`),
   size:Number(value.size),isDir:value.isDirectory(),mode:Number(value.mode&0o777n)};
 }catch(error){if(error.code==='ENOENT')return null;throw error;}};
 return {call:async(context,input)=>{
  record(input);const workspace=typeof workspaceDir==='function'?workspaceDir(context):workspaceDir;
  assert(!input.path.startsWith('/')&&!input.path.split('/').includes('..'));const path=join(workspace,input.path);
  if(input.operation==='stat'){const value=await stat(path);if(!value)throw Object.assign(Error('missing'),{code:'entry_not_found'});return value;}
  if(input.operation==='listStrict')return {entries:await Promise.all((await readdir(path)).map(async name=>{const value=await stat(join(path,name));return {name,isDir:value.isDir,size:value.size};}))};
  if(input.operation==='readChunk'){const bytes=await readFile(path);return {bytes:[...bytes.subarray(input.offset,input.offset+input.limit)],size:bytes.length,offset:input.offset};}
  if(input.operation==='mkdirAll'){await mkdir(path,{recursive:true});return {created:true};}
  if(input.operation==='writeChunk'){await writeFile(path,Buffer.from(input.bytes),{flag:input.offset===0?'wx':'a',mode:0o600});return {written:input.bytes.length};}
  if(input.operation==='restoreIfRevision'){
   await beforeRestore(input);const current=await stat(path);assert.equal(current?.revision??null,input.expectedRevision);
   if(input.stagedPath===null)await rm(path);else{
    const staged=join(workspace,input.stagedPath);assert.equal((await stat(staged)).revision,input.expectedSourceRevision);
    await chmod(staged,input.mode);await rename(staged,path);
   }
   await afterRestore(input);return {restored:true,stat:await stat(path)};
  }
  throw Error(`Unexpected operation ${input.operation}`);
 }};
}
