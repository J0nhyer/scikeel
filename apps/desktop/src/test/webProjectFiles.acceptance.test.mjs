// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtemp,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import {expect,test} from 'vitest';

test.skipIf(!process.env.OSD_PROJECT_FILES_ACCEPTANCE)('Web project management works at desktop and phone widths with actual platform lifecycle routes',async()=>{
 const webRoot=process.env.OSD_WEB_CANDIDATE;
 if(!webRoot)throw new Error('OSD_WEB_CANDIDATE must identify the guarded candidate Web build');
 await access(join(webRoot,'index.html'));
 const module=name=>import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
 const [{AuthStore},{PlatformServer},{TenantPolicy}]=await Promise.all(['auth-store','platform-server','tenant-policy'].map(module));
 const root=await mkdtemp(join(tmpdir(),'project-files-browser-'));
 let worker;let busy=false;let renameFailure=false,loseChunkReply=false;
 let revision=0;const payloads=new Map();const nextRevision=()=> (++revision).toString(16).padStart(64,'0');
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path),fail=code=>{throw Object.assign(new Error(code),{code,statusCode:code==='entry_not_found'?404:409});};
  if(request.operation==='stat'){if(!entry)fail('entry_not_found');return {identity:entry.identity,revision:entry.revision,isDir:entry.isDir,size:entry.size};}
  if(request.operation==='mkdirAll')return {created:true};
  if(request.operation==='mkdir' || request.operation==='createText'){
   if(entry)fail('name_conflict');const result={identity:'fixture-'+nextRevision(),revision:nextRevision(),isDir:request.operation==='mkdir',size:Buffer.byteLength(request.text??''),text:request.text??''};payloads.set(request.path,result);return {...result};
  }
  if(request.operation==='readText'){if(!entry)fail('entry_not_found');return {text:entry.text,revision:entry.revision};}
  if(request.operation==='writeChunk'){
   if((request.offset===0 && entry) || (request.offset>0 && (!entry || entry.size!==request.offset)))fail('offset_conflict');
   const bytes=Buffer.concat([entry?.bytes??Buffer.alloc(0),Buffer.from(request.bytes)]),result={identity:entry?.identity??'fixture-'+nextRevision(),revision:nextRevision(),isDir:false,size:bytes.length,bytes};payloads.set(request.path,result);
   if(loseChunkReply){loseChunkReply=false;throw new Error('Fixture lost chunk response');}return {};
  }
  if(request.operation==='readChunk'){if(!entry)fail('entry_not_found');const bytes=entry.bytes??Buffer.from(entry.text??'');return {size:entry.size,bytes:[...bytes.subarray(request.offset,request.offset+request.limit)]};}
  if(request.operation==='remove'){if(!entry)fail('entry_not_found');payloads.delete(request.path);return {};}
  if(request.operation==='moveNoReplace'){
   if(!entry)fail('entry_not_found');if(entry.revision!==request.expectedRevision)fail('revision_conflict');if(payloads.has(request.destinationPath))fail('name_conflict');
   payloads.delete(request.path);entry.revision=nextRevision();payloads.set(request.destinationPath,entry);return {...entry};
  }
  throw new Error('Unexpected fixture file operation');
 }};
 const projects=[{id:'123456789abcdef0',name:'Project A',path:root+'/workspace/projects/a',createdAt:1,imported:false,pinned:false}];
 const upstream=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://worker');response.setHeader('content-type','application/json');
  if(url.pathname==='/v1/whoami')return response.end(JSON.stringify({directory:root+'/workspace',mode:'full'}));
  if(url.pathname==='/v1/projects')return response.end(JSON.stringify(projects));
  if(url.pathname==='/v1/projects/'+projects[0].id && request.method==='PATCH'){
   if(renameFailure){renameFailure=false;response.statusCode=400;return response.end('{"error":"Fixture rename failure"}');}
   let body='';for await(const chunk of request)body+=chunk;projects[0].name=JSON.parse(body).name;return response.end('{"ok":true}');
  }
  if(url.pathname==='/v1/projects/'+projects[0].id+'/pin'){
   let body='';for await(const chunk of request)body+=chunk;projects[0].pinned=JSON.parse(body).pinned;return response.end('{"ok":true}');
  }
  if(url.pathname==='/v1/fs/list'){
   const prefix=posix.relative(root+'/workspace',url.searchParams.get('dir')??root+'/workspace');
   const relative=url.searchParams.get('path')??'',directory=prefix+(relative?'/'+relative:'');
   const entries=[...payloads].filter(([path])=>posix.dirname(path)===directory).map(([path,entry])=>({name:posix.basename(path),path:posix.relative(prefix,path),isDir:entry.isDir,size:entry.size,modified:1}));
   return response.end(JSON.stringify(entries));
  }
  if(url.pathname==='/session/status')return response.end(busy?'{"ses_a":{"type":"busy"}}':'{}');
  if(['/session','/experimental/session','/permission','/question','/agent','/command','/skill'].includes(url.pathname))return response.end('[]');
  if(url.pathname==='/event'){response.setHeader('content-type','text/event-stream');return response.end('data: {"type":"server.connected","properties":{}}\n\n');}
  response.statusCode=404;response.end('{}');
 });
 await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
 const authStore=new AuthStore({filePath:join(root,'auth.json'),bootstrapAdmin:{username:'fixture',password:'fixture-password'}});
 const policy=new TenantPolicy();
 const manager={rootDir:join(root,'workers'),init:async()=>{},getWorker:()=>worker,getWorkerAccess:()=>({url:`http://127.0.0.1:${upstream.address().port}`,token:'internal'}),
  client:{inspect:async()=>({instanceId:worker.id,generation:worker.generation,status:'ready',quota:{enforced:true,byteLimit:128*1024**2,inodeLimit:1024,bytes:0,inodes:0}})},
  ensureWorker:async({userId})=>{worker={id:'user-'+userId,userId,generation:1,status:'running',workspaceDir:root+'/workspace'};policy.registerAccount({...worker,instanceId:worker.id});},
  retainWorker:()=>({release(){}})};
 const platform=new PlatformServer({authStore,workerManager:manager,tenantPolicy:policy,workspaceFiles:native,enableWorkspaceManagement:true,webRoot,
  runtimeCatalog:async()=>({providers:[{id:'fixture',name:'Fixture',models:{model:{id:'model',providerID:'fixture',name:'Fixture'}}}],connected:['fixture'],default:{fixture:'model'},model:'fixture/model'})});
 const address=await platform.listen(),origin=`http://${address.host}:${address.port}`;
 const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
 const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  for(const width of [1280,390,320]){
   projects[0].name='Project A';busy=false;
   payloads.clear();payloads.set('projects/a',{identity:'fixture-project',revision:nextRevision(),isDir:true,size:0});payloads.set('projects/a/result.txt',{identity:'fixture-result',revision:nextRevision(),isDir:false,size:7,text:'retained'});
   const context=await browser.newContext({viewport:{width,height:900}});
   try{
    const login=await context.request.post(origin+'/auth/login',{headers:{accept:'application/json'},data:{username:'fixture',password:'fixture-password'}});expect(login.status()).toBe(200);
    expect((await context.request.get(origin+'/v1/whoami')).status()).toBe(200);
    await context.addInitScript(()=>{Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});});
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/projects');
    const menu=()=>page.getByRole('button',{name:'Project actions: '+projects[0].name}).last();
    try{await menu().waitFor({timeout:30000});}catch(error){console.error('Project management page:',await page.locator('body').innerText(),'Errors:',errors);throw error;}await menu().click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Rename',exact:true});
    const renamed='Renamed '+width;await dialog.getByRole('textbox').fill(renamed);
    if(width===1280){renameFailure=true;await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.getByRole('alert').waitFor();expect(await dialog.getByRole('textbox').inputValue()).toBe(renamed);}
    await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});
    expect(projects[0].name).toBe(renamed);expect(projects[0].path).toBe(root+'/workspace/projects/a');
    await page.reload();await menu().waitFor();await menu().click();await page.getByRole('menuitem',{name:'Open files',exact:true}).click();
    await page.getByText('result.txt',{exact:true}).waitFor();expect(page.url()).toContain('project=123456789abcdef0');
    const fileView=origin+'/files?project=123456789abcdef0';
    const uploadBytes=Buffer.alloc(256*1024+3,17),uploadName='uploaded-'+width+'.bin';loseChunkReply=true;
    await page.locator('input[aria-label="Upload files"]').setInputFiles({name:uploadName,mimeType:'application/octet-stream',buffer:uploadBytes});
    const uploads=page.getByRole('dialog',{name:'Uploads',exact:true});await uploads.getByRole('alert').waitFor();
    expect(payloads.has('projects/a/'+uploadName)).toBe(false);
    await page.reload();await page.getByRole('dialog',{name:'Uploads',exact:true}).waitFor();
    await page.locator('input[aria-label="Resume upload: '+uploadName+'"]').setInputFiles({name:uploadName,mimeType:'application/octet-stream',buffer:uploadBytes});
    try{await page.getByRole('dialog',{name:'Uploads',exact:true}).getByText('Uploaded',{exact:true}).waitFor();}
    catch(error){console.error('Upload recovery:',await page.locator('body').innerText(),'Browser errors:',errors,'Receipts:',await (await context.request.get(origin+'/api/workspace/uploads')).json());throw error;}
    expect(payloads.get('projects/a/'+uploadName)?.bytes.equals(uploadBytes)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    const uploadEvidence=resolve('../../.deploy/verification/web-project-management');await mkdir(uploadEvidence,{recursive:true});
    await page.screenshot({path:join(uploadEvidence,`uploads-${width}.png`),fullPage:true});
    await page.getByRole('dialog',{name:'Uploads',exact:true}).getByRole('button',{name:'Close details',exact:true}).click();
    const cancelName='cancelled-'+width+'.bin';loseChunkReply=true;
    await page.locator('input[aria-label="Upload files"]').setInputFiles({name:cancelName,mimeType:'application/octet-stream',buffer:Buffer.from('cancel')});
    await page.getByRole('dialog',{name:'Uploads',exact:true}).getByRole('alert').waitFor();
    await page.getByRole('button',{name:'Cancel upload: '+cancelName,exact:true}).click();
    await page.getByRole('dialog',{name:'Uploads',exact:true}).getByText('Cancelled',{exact:true}).waitFor();
    expect(payloads.has('projects/a/'+cancelName)).toBe(false);
    await page.getByRole('dialog',{name:'Uploads',exact:true}).getByRole('button',{name:'Close details',exact:true}).click();
    await page.getByRole('button',{name:'New folder',exact:true}).click();
    await page.getByRole('dialog',{name:'New folder',exact:true}).getByRole('textbox').fill('reports');
    await page.getByRole('dialog',{name:'New folder',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'reports',exact:true}).waitFor();
    await page.getByRole('button',{name:'New file',exact:true}).click();
    await page.getByRole('dialog',{name:'New file',exact:true}).getByRole('textbox').fill('note.txt');
    await page.getByRole('dialog',{name:'New file',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'File actions: note.txt',exact:true}).click();
    await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('textbox').fill('renamed.txt');
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'File actions: renamed.txt',exact:true}).click();
    await page.getByRole('menuitem',{name:'Move',exact:true}).click();
    await page.getByRole('dialog',{name:'Move',exact:true}).getByRole('combobox',{name:'Destination'}).selectOption('reports');
    await page.getByRole('dialog',{name:'Move',exact:true}).getByRole('button',{name:'Move',exact:true}).click();
    await page.getByRole('dialog',{name:'Move',exact:true}).waitFor({state:'hidden'});
    await page.getByRole('button',{name:'reports',exact:true}).click();
    await page.getByRole('button',{name:'File actions: renamed.txt',exact:true}).waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    const fileEvidence=resolve('../../.deploy/verification/web-project-management');await mkdir(fileEvidence,{recursive:true});
    await page.screenshot({path:join(fileEvidence,`files-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'File actions: renamed.txt',exact:true}).click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});
    await page.goto(origin+'/files?view=trash');await page.getByText('reports/renamed.txt',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByText('No deleted items.',{exact:true}).waitFor();
    await page.goto(fileView);await page.getByRole('button',{name:'File actions: renamed.txt',exact:true}).waitFor();
    expect(payloads.get('projects/a/reports/renamed.txt')?.text).toBe('');expect(payloads.get('projects/a/result.txt')?.text).toBe('retained');
    await page.goto(origin+'/projects');await menu().click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();expect((await (await context.request.get(origin+'/api/workspace/trash')).json()).length).toBe(0);
    await menu().click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    if(width===1280){busy=true;await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').getByRole('alert').waitFor();busy=false;}
    await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});
    expect((await (await context.request.get(origin+'/v1/projects')).json()).length).toBe(0);
    await page.getByRole('button',{name:'Trash',exact:true}).click();await page.getByText(renamed,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByText('No deleted items.',{exact:true}).waitFor();
    await page.goto(origin+'/projects');await menu().waitFor();
    const evidence=resolve('../../.deploy/verification/web-project-management');
    await mkdir(evidence,{recursive:true});
    await page.screenshot({path:join(evidence,`projects-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
   }finally{await context.close();}
  }
 }finally{await browser.close();await platform.close();await new Promise(done=>upstream.close(done));await rm(root,{recursive:true,force:true});}
},180000);
