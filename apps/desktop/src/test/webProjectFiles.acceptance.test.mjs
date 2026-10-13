// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtemp,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {expect,test} from 'vitest';

test.skipIf(!process.env.OSD_PROJECT_FILES_ACCEPTANCE)('Web project management works at desktop and phone widths with actual platform lifecycle routes',async()=>{
 const webRoot=process.env.OSD_WEB_CANDIDATE;
 if(!webRoot)throw new Error('OSD_WEB_CANDIDATE must identify the guarded candidate Web build');
 await access(join(webRoot,'index.html'));
 const module=name=>import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
 const [{AuthStore},{PlatformServer},{TenantPolicy}]=await Promise.all(['auth-store','platform-server','tenant-policy'].map(module));
 const root=await mkdtemp(join(tmpdir(),'project-files-browser-'));
 let worker;let busy=false;let renameFailure=false;
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
  if(url.pathname==='/v1/fs/list')return response.end(JSON.stringify([{name:'result.txt',path:'result.txt',isDir:false,size:7,modified:1}]));
  if(url.pathname==='/session/status')return response.end(busy?'{"ses_a":{"type":"busy"}}':'{}');
  if(['/session','/experimental/session','/permission','/question','/agent','/command','/skill'].includes(url.pathname))return response.end('[]');
  if(url.pathname==='/event'){response.setHeader('content-type','text/event-stream');return response.end('data: {"type":"server.connected","properties":{}}\n\n');}
  response.statusCode=404;response.end('{}');
 });
 await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
 const authStore=new AuthStore({filePath:join(root,'auth.json'),bootstrapAdmin:{username:'fixture',password:'fixture-password'}});
 const policy=new TenantPolicy();
 const manager={rootDir:join(root,'workers'),init:async()=>{},getWorker:()=>worker,getWorkerAccess:()=>({url:`http://127.0.0.1:${upstream.address().port}`,token:'internal'}),
  ensureWorker:async({userId})=>{worker={id:'user-'+userId,userId,generation:1,status:'running',workspaceDir:root+'/workspace'};policy.registerAccount({...worker,instanceId:worker.id});},
  retainWorker:()=>({release(){}})};
 const platform=new PlatformServer({authStore,workerManager:manager,tenantPolicy:policy,enableWorkspaceManagement:true,webRoot,
  runtimeCatalog:async()=>({providers:[{id:'fixture',name:'Fixture',models:{model:{id:'model',providerID:'fixture',name:'Fixture'}}}],connected:['fixture'],default:{fixture:'model'},model:'fixture/model'})});
 const address=await platform.listen(),origin=`http://${address.host}:${address.port}`;
 const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
 const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  for(const width of [1280,390,320]){
   projects[0].name='Project A';busy=false;
   const context=await browser.newContext({viewport:{width,height:900}});
   try{
    const login=await context.request.post(origin+'/auth/login',{headers:{accept:'application/json'},data:{username:'fixture',password:'fixture-password'}});expect(login.status()).toBe(200);
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
    await page.goto(origin+'/projects');await menu().click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();expect((await (await context.request.get(origin+'/api/workspace/trash')).json()).length).toBe(0);
    await menu().click();await page.getByRole('menuitem',{name:'Move to trash',exact:true}).click();
    if(width===1280){busy=true;await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').getByRole('alert').waitFor();busy=false;}
    await page.getByRole('alertdialog').getByRole('button',{name:'Move to trash',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'hidden'});
    expect((await (await context.request.get(origin+'/v1/projects')).json()).length).toBe(0);
    await page.getByRole('button',{name:'Trash',exact:true}).click();await page.getByText(renamed,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByText('No deleted projects.',{exact:true}).waitFor();
    await page.goto(origin+'/projects');await menu().waitFor();
    const evidence=resolve('../../.deploy/verification/web-project-management');
    await mkdir(evidence,{recursive:true});
    await page.screenshot({path:join(evidence,`projects-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);expect(errors).toEqual([]);
   }finally{await context.close();}
  }
 }finally{await browser.close();await platform.close();await new Promise(done=>upstream.close(done));await rm(root,{recursive:true,force:true});}
},180000);
