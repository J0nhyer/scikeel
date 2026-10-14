import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {expect} from 'vitest';

/** Opt-in acceptance against an isolated real managed platform, never a native RPC fixture. */
export async function verifyLiveProjectFiles(){
 const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
 const origin=process.env.OSD_WEB_ORIGIN||'http://127.0.0.1:4790';
 const password=process.env.OSD_WEB_PASSWORD||execFileSync('sudo',['-n','sed','-n','s/^PLATFORM_ADMIN_PASSWORD=//p','/etc/osd-platform.env'],{encoding:'utf8'}).trim();
 const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const evidence=resolve('../../.deploy/verification/web-project-management-live');await mkdir(evidence,{recursive:true});
 const id=()=>randomUUID();let project;const views=[];
 try{
  expect((await context.request.post(origin+'/auth/login',{headers:{accept:'application/json'},data:{username:'admin',password}})).status()).toBe(200);
  await context.addInitScript(()=>localStorage.setItem('ai4s.locale','en'));
  const runtime=await (await context.request.get(origin+'/api/runtime')).json();expect(runtime.runtime).toBe('opencode');
  const headers={'x-scikeel-runtime-generation':String(runtime.context.generation)};
  const request=async(path,method='GET',data,status=200)=>{
   const response=await context.request.fetch(origin+path,{method,headers,...(data!==undefined?{data}:{})});
   const value=await response.json();expect(response.status(),value.code??'live request').toBe(status);return value;
  };
  project=await request('/v1/projects','POST',{name:'Management acceptance '+Date.now()});
  expect(project.id).toMatch(/^[a-f0-9]{16}$/);expect(project.path).toBeTruthy();
  const scope={kind:'project',projectId:project.id};
  const text=path=>request('/api/workspace/text?'+new URLSearchParams({scope:JSON.stringify(scope),path}));
  const operate=async(operation,operationId=id())=>{
   const result=await request('/api/workspace/operations','POST',{scope,operation,operationId});
   expect(result.state).toBe('committed');expect(result.warning).toBeUndefined();
   expect((await request('/api/workspace/operations/'+operationId)).state).toBe('committed');return result;
  };
  await operate({kind:'createDirectory',path:'reports'});
  await operate({kind:'createFile',path:'note.txt',text:'original'});
  const before=await text('note.txt');await operate({kind:'saveText',path:'note.txt',expectedRevision:before.revision,text:'manual save'});
  await request('/api/workspace/operations','POST',{scope,operationId:id(),operation:{kind:'saveText',path:'note.txt',expectedRevision:before.revision,text:'must not overwrite'}},409);
  expect((await text('note.txt')).text).toBe('manual save');
  const bytes=Buffer.alloc(300*1024,65),sha256=createHash('sha256').update(bytes).digest('hex');
  const upload=await request('/api/workspace/uploads','POST',{scope,path:'upload.bin',size:bytes.length,sha256,operationId:id()});
  for(let offset=0;offset<bytes.length;offset+=upload.chunkSize){
   const response=await context.request.put(origin+'/api/workspace/uploads/'+upload.id+'/chunks?offset='+offset,{headers:{...headers,'content-type':'application/octet-stream'},data:bytes.subarray(offset,offset+upload.chunkSize)});expect(response.status()).toBe(200);
  }
  expect((await request('/api/workspace/uploads/'+upload.id+'/commit','POST',{operationId:id()})).state).toBe('committed');
  const pending=await request('/api/workspace/uploads','POST',{scope,path:'cancelled.bin',size:3,operationId:id()});
  expect((await request('/api/workspace/uploads/'+pending.id,'DELETE',{})).state).toBe('cancelled');
  const moved=await operate({kind:'move',path:'note.txt',destinationPath:'reports/moved.txt',expectedRevision:(await text('note.txt')).revision});
  const trashed=await operate({kind:'trash',path:'reports/moved.txt',expectedRevision:moved.result.revision});
  await operate({kind:'createFile',path:'reports/moved.txt',text:'collision'});
  await request('/api/workspace/trash/'+trashed.result.trashId+'/restore','POST',{operationId:id()},409);
  expect((await request('/api/workspace/trash/'+trashed.result.trashId+'/restore','POST',{operationId:id(),destinationPath:'restored.txt'})).state).toBe('committed');
  expect((await text('restored.txt')).text).toBe('manual save');
  const session=await request('/session?directory='+encodeURIComponent(project.path),'POST',{title:'Management acceptance conversation'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});await page.goto(origin+'/projects');
   await page.getByRole('button',{name:'Project actions: '+project.name}).last().click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'Rename',exact:true});project.name='Managed project '+width+' '+Date.now();
   await dialog.getByRole('textbox').fill(project.name);await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Project actions: '+project.name}).last().click();await page.getByRole('menuitem',{name:'Open files',exact:true}).click();
   await page.getByRole('button',{name:'File actions: restored.txt',exact:true}).waitFor();
   await page.getByRole('button',{name:'restored.txt',exact:true}).click();await page.getByRole('button',{name:'Edit',exact:true}).click();
   const editor=page.getByRole('textbox',{name:'restored.txt'});await editor.fill('Browser save '+width);await page.getByRole('button',{name:'Save',exact:true}).click();
   await expect.poll(async()=>(await text('restored.txt')).text).toBe('Browser save '+width);
   await page.reload();await page.getByRole('button',{name:'File actions: restored.txt',exact:true}).waitFor();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(evidence,'files-'+width+'.png'),fullPage:true});views.push(width);
  }
  expect(errors).toEqual([]);
  const current=(await request('/api/workspace/projects')).find(item=>item.id===project.id);
  await request('/api/workspace/projects/'+project.id+'/trash','POST',{expectedRevision:current.revision,operationId:id()});
  expect((await request('/api/workspace/projects')).some(item=>item.id===project.id)).toBe(false);
  expect((await request('/api/workspace/sessions/'+session.id+'/state')).state).toBe('trashed');
  const denied=await context.request.get(origin+'/session/'+session.id+'?directory='+encodeURIComponent(project.path));expect(denied.ok()).toBe(false);
  await request('/api/workspace/trash/'+project.id+'/restore','POST',{operationId:id()});
  expect((await request('/session/'+session.id+'?directory='+encodeURIComponent(project.path))).id).toBe(session.id);
  await writeFile(join(evidence,'live.json'),JSON.stringify({verifiedAt:new Date().toISOString(),projectId:project.id,sessionId:session.id,views,nativeFileRpc:true,conditionalSave:true,chunkedUpload:true,alternateRestore:true,projectSessionPreserved:true,status:'passed'},null,2));
 }finally{await context.close();await browser.close();}
}
