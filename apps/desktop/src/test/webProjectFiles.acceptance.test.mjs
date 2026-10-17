// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtemp,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import {expect,test} from 'vitest';

test.skipIf(!process.env.OSD_PROJECT_FILES_ACCEPTANCE && !process.env.OSD_PROJECT_FILES_LIVE_ACCEPTANCE)('Web project management works at desktop and phone widths with actual platform lifecycle routes',async()=>{
 if(process.env.OSD_PROJECT_FILES_LIVE_ACCEPTANCE){const {verifyLiveProjectFiles}=await import('./webProjectFiles.live.mjs');return verifyLiveProjectFiles();}
 const webRoot=process.env.OSD_WEB_CANDIDATE;
 if(!webRoot)throw new Error('OSD_WEB_CANDIDATE must identify the guarded candidate Web build');
 await access(join(webRoot,'index.html'));
 const module=name=>import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
 const [{AuthStore},{PlatformServer},{TenantPolicy},{CliRuntimeManager}]=await Promise.all(['auth-store','platform-server','tenant-policy','cli-runtime'].map(module));
 const root=await mkdtemp(join(tmpdir(),'project-files-browser-'));
 let worker;let busy=false;let renameFailure=false,loseChunkReply=false,loseMoveBeforeDispatch=false,loseTextBeforeDispatch=false,loseTextReply=false;
 let revision=0;const payloads=new Map();const nextRevision=()=> (++revision).toString(16).padStart(64,'0');
 const native={call:async(_context,request)=>{
  const entry=payloads.get(request.path),fail=code=>{throw Object.assign(new Error(code),{code,statusCode:code==='entry_not_found'?404:409});};
  if(request.operation==='stat'){if(!entry)fail('entry_not_found');return {identity:entry.identity,revision:entry.revision,isDir:entry.isDir,size:entry.size};}
  if(request.operation==='mkdirAll')return {created:true};
  if(request.operation==='snapshot')return {committed:false};
  if(request.operation==='mkdir' || request.operation==='createText'){
   if(entry)fail('name_conflict');const result={identity:'fixture-'+nextRevision(),revision:nextRevision(),isDir:request.operation==='mkdir',size:Buffer.byteLength(request.text??''),text:request.text??''};payloads.set(request.path,result);return {...result};
  }
  if(request.operation==='readText'){if(!entry)fail('entry_not_found');return {text:entry.text,revision:entry.revision};}
  if(request.operation==='replaceTextFromStaging'){
   if(loseTextBeforeDispatch){loseTextBeforeDispatch=false;throw new Error('Fixture lost text dispatch');}
   const destination=payloads.get(request.destinationPath);if(!entry)fail('entry_not_found');
   if(entry.revision!==request.expectedSourceRevision || destination?.revision!==request.expectedRevision)fail('revision_conflict');
   payloads.delete(request.path);entry.revision=nextRevision();payloads.set(request.destinationPath,entry);
   if(loseTextReply){loseTextReply=false;throw new Error('Fixture lost text response');}return {text:entry.text,revision:entry.revision};
  }
  if(request.operation==='writeChunk'){
   if((request.offset===0 && entry) || (request.offset>0 && (!entry || entry.size!==request.offset)))fail('offset_conflict');
   const bytes=Buffer.concat([entry?.bytes??Buffer.alloc(0),Buffer.from(request.bytes)]),result={identity:entry?.identity??'fixture-'+nextRevision(),revision:nextRevision(),isDir:false,size:bytes.length,bytes};payloads.set(request.path,result);
   if(loseChunkReply){loseChunkReply=false;throw new Error('Fixture lost chunk response');}return {};
  }
  if(request.operation==='readChunk'){if(!entry)fail('entry_not_found');const bytes=entry.bytes??Buffer.from(entry.text??'');return {size:entry.size,bytes:[...bytes.subarray(request.offset,request.offset+request.limit)]};}
  if(request.operation==='remove'){if(!entry)fail('entry_not_found');payloads.delete(request.path);return {};}
  if(request.operation==='moveNoReplace'){
   if(loseMoveBeforeDispatch){loseMoveBeforeDispatch=false;throw new Error('Fixture lost dispatch');}
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
   const entries=[...payloads].filter(([path])=>posix.dirname(path)===directory && !posix.basename(path).startsWith('.')).map(([path,entry])=>({name:posix.basename(path),path:posix.relative(prefix,path),isDir:entry.isDir,size:entry.size,modified:1}));
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
  cliRuntime:new CliRuntimeManager({rootDir:join(root,'cli'),codexHome:join(root,'codex'),claudeConfigDir:join(root,'claude'),
   assistantAuthority:{inventory:async()=>({activeExecutions:[],uncertainEffects:[]})}}),
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
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.stack??error.message));
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
    await page.getByRole('button',{name:'File actions: result.txt',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('textbox').fill('recovered.txt');loseMoveBeforeDispatch=true;
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('alert').waitFor();await page.reload();
    const pending=page.getByRole('region',{name:'Pending operations',exact:true});await pending.waitFor();
    await pending.getByRole('button',{name:'Retry operation: result.txt',exact:true}).click();await pending.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'File actions: recovered.txt',exact:true}).waitFor();
    await page.getByRole('button',{name:'File actions: recovered.txt',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
    await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('textbox').fill('result.txt');await page.getByRole('dialog',{name:'Rename',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('dialog',{name:'Rename',exact:true}).waitFor({state:'hidden'});
    const uploadBytes=Buffer.alloc(256*1024+3,17),uploadName='uploaded-'+width+'.bin';loseChunkReply=true;
    await page.waitForFunction(()=>document.querySelector('input[aria-label="Upload files"]')?.disabled===false);
    await page.locator('input[aria-label="Upload files"]').setInputFiles({name:uploadName,mimeType:'application/octet-stream',buffer:uploadBytes});
    const uploads=page.getByRole('dialog',{name:'Uploads',exact:true});try{await uploads.getByRole('alert').waitFor();}catch(error){console.error('Upload admission:',await page.locator('body').innerText(),'Disabled:',await page.locator('input[aria-label="Upload files"]').isDisabled(),'Receipts:',await (await context.request.get(origin+'/api/workspace/uploads')).json(),'Errors:',errors);throw error;}
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
    await page.waitForFunction(()=>document.querySelector('input[aria-label="Upload files"]')?.disabled===false);
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
    const textPath='projects/a/text.txt',manual='manual UTF-8 \u4e2d\u6587 '+width;
    payloads.set(textPath,{identity:'fixture-text',revision:nextRevision(),isDir:false,size:8,text:'original'});
    await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:/^text.txt/}).click();
    await page.getByRole('button',{name:'Edit this file',exact:true}).click();const editor=page.getByRole('textbox',{name:'text.txt',exact:true});await editor.waitFor();
    const replaceDraft=async text=>{await editor.focus();await editor.press('Control+A');await page.keyboard.insertText(text);};
    await replaceDraft(manual);expect(payloads.get(textPath).text).toBe('original');
    const draftText=async()=> (await page.locator('.monaco-editor .view-lines').textContent()).replaceAll('\u00a0',' ');
    page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Close inspector',exact:true}).click();expect(await draftText()).toBe(manual);
    loseTextReply=true;await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).waitFor();
    await page.getByLabel('Saved',{exact:true}).waitFor();expect(payloads.get(textPath).text).toBe(manual);
    await replaceDraft('my conflicting draft');payloads.get(textPath).text='AI edit';payloads.get(textPath).size=7;payloads.get(textPath).revision=nextRevision();
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('alert').filter({hasText:'The file changed on disk'}).waitFor();expect(await draftText()).toBe('my conflicting draft');expect(payloads.get(textPath).text).toBe('AI edit');
    await page.getByRole('button',{name:'Save As',exact:true}).click();await page.getByRole('dialog',{name:'Save As',exact:true}).getByRole('textbox').fill('copy.txt');await page.getByRole('dialog',{name:'Save As',exact:true}).getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('dialog',{name:'Save As',exact:true}).waitFor({state:'hidden'});expect(payloads.get('projects/a/copy.txt').text).toBe('my conflicting draft');expect(payloads.get(textPath).text).toBe('AI edit');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reload Disk Version',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.replaceAll('\u00a0',' ')==='AI edit');
    await replaceDraft('Save As draft after refresh');loseMoveBeforeDispatch=true;
    await page.getByRole('button',{name:'Save As',exact:true}).click();const saveAs=page.getByRole('dialog',{name:'Save As',exact:true});await saveAs.getByRole('textbox').fill('recovered-copy.txt');await saveAs.getByRole('button',{name:'Save',exact:true}).click();await saveAs.getByRole('alert').waitFor();
    page.once('dialog',dialog=>dialog.accept());await page.reload();await pending.waitFor();await pending.getByRole('button',{name:'Retry operation: recovered-copy.txt',exact:true}).click();await pending.waitFor({state:'hidden'});
    expect(payloads.get('projects/a/recovered-copy.txt').text).toBe('Save As draft after refresh');expect(payloads.get(textPath).text).toBe('AI edit');
    await page.getByRole('button',{name:/^text.txt/}).click();await page.getByRole('button',{name:'Edit this file',exact:true}).click();await editor.waitFor();
    await replaceDraft('recover after refresh');loseTextBeforeDispatch=true;await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('alert').filter({hasText:'Save result is unknown'}).waitFor();
    page.once('dialog',dialog=>dialog.accept());await page.reload();await pending.waitFor();await pending.getByRole('button',{name:'Retry operation: text.txt',exact:true}).click();await pending.waitFor({state:'hidden'});expect(payloads.get(textPath).text).toBe('recover after refresh');
    await page.getByRole('button',{name:/^text.txt/}).click();await page.getByRole('button',{name:'Edit this file',exact:true}).click();await editor.waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);await page.screenshot({path:join(fileEvidence,`text-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'Close inspector',exact:true}).click();
    await page.getByRole('button',{name:'File actions: copy.txt',exact:true}).click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});
    payloads.set('projects/a/copy.txt',{identity:'new-ai-copy',revision:nextRevision(),isDir:false,size:11,text:'AI new file'});
    await page.goto(origin+'/files?view=trash');await page.getByText('copy.txt',{exact:true}).waitFor();await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByRole('alert').waitFor();
    expect(payloads.get('projects/a/copy.txt').text).toBe('AI new file');await page.getByRole('button',{name:'Restore elsewhere',exact:true}).click();const restoration=page.getByRole('dialog',{name:'Restore file or folder',exact:true});
    await restoration.getByRole('combobox',{name:'Destination',exact:true}).selectOption('reports');await restoration.getByRole('textbox',{name:'Name',exact:true}).fill('restored-copy.txt');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(await restoration.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await page.screenshot({path:join(fileEvidence,`restore-${width}.png`),fullPage:true});
    await restoration.getByRole('button',{name:'Restore',exact:true}).click();await restoration.waitFor({state:'hidden'});await page.getByText('No deleted items.',{exact:true}).waitFor();
    expect(payloads.get('projects/a/reports/restored-copy.txt').text).toBe('my conflicting draft');expect(payloads.get('projects/a/copy.txt').text).toBe('AI new file');
    for(let index=0;index<105;index++)payloads.set('projects/a/zzz-page-'+String(index).padStart(3,'0')+'.txt',{identity:'page-'+index,revision:nextRevision(),isDir:false,size:0,text:''});
    await page.goto(fileView);await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Load more',exact:true}).click();
    await page.getByRole('button',{name:'File actions: zzz-page-104.txt',exact:true}).waitFor();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.goto(origin+'/projects');await menu().click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();expect((await (await context.request.get(origin+'/api/workspace/trash')).json()).items.length).toBe(0);
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
