import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PREVIEW_PATH='/preview/agent-analytics';
const root=fileURLToPath(new URL('.',import.meta.url));
const assets=new Map([['/','index.html'],['/app.css','app.css'],['/app.js','app.mjs'],['/logo.webp','logo.webp'],['/inter-400.woff2','inter-400.woff2'],['/inter-500.woff2','inter-500.woff2'],['/inter-600.woff2','inter-600.woff2'],['/serif-600.woff2','serif-600.woff2']]);
const mime={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',webp:'image/webp',woff2:'font/woff2'};
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow','referrer-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const errorPage=(status,message)=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · SciKeel</title><body style="font:14px system-ui;max-width:480px;margin:12vh auto;padding:24px;color:#2a2723"><h1 style="font-size:22px">${message}</h1><p>This preview is available to platform administrators.</p><a href="/live">Return to the workbench</a></body></html>`;
export function createPreviewServer({platformOrigin='http://127.0.0.1:4790',fetchImpl=fetch}={}){
  const origin=new URL(platformOrigin);
  if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw new Error('Preview authentication must use a local platform');
  return createServer(async(req,res)=>{
    const respond=(status,body,type='text/html; charset=utf-8',extra={})=>{res.writeHead(status,{...headers,'content-type':type,...extra});res.end(req.method==='HEAD'?undefined:body)};
    try{
      const url=new URL(req.url,'http://preview.local');
      if(url.pathname!==PREVIEW_PATH&&!url.pathname.startsWith(`${PREVIEW_PATH}/`)){respond(404,errorPage(404,'Preview not found'));return;}
      if(!['GET','HEAD'].includes(req.method)){respond(405,'Method not allowed','text/plain; charset=utf-8',{allow:'GET, HEAD'});return;}
      const cookie=String(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>/^osd_session=[A-Za-z0-9_-]{20,128}$/.test(v));
      if(!cookie){if(url.pathname===PREVIEW_PATH||url.pathname===`${PREVIEW_PATH}/`){respond(303,'','text/plain',{location:`/login?next=${encodeURIComponent(PREVIEW_PATH)}`});}else respond(401,JSON.stringify({error:'authentication required'}),'application/json');return;}
      let identity;
      try{identity=await fetchImpl(new URL('/api/me',origin),{headers:{cookie,accept:'application/json'},signal:AbortSignal.timeout(3000),redirect:'error'});}catch{respond(503,errorPage(503,'Account verification is temporarily unavailable'));return;}
      if(identity.status===401){if(url.pathname===PREVIEW_PATH||url.pathname===`${PREVIEW_PATH}/`)respond(303,'','text/plain',{location:`/login?next=${encodeURIComponent(PREVIEW_PATH)}`});else respond(401,JSON.stringify({error:'authentication required'}),'application/json');return;}
      if(!identity.ok){respond(503,errorPage(503,'Account verification is temporarily unavailable'));return;}
      const body=await identity.json();
      if(!body?.user||body.user.role!=='admin'||body.user.disabled){respond(403,errorPage(403,'Administrator access required'));return;}
      if(url.pathname===`${PREVIEW_PATH}/me.json`){respond(200,JSON.stringify({user:{username:body.user.username,role:'admin'}}),'application/json');return;}
      const suffix=url.pathname===PREVIEW_PATH?'/':url.pathname.slice(PREVIEW_PATH.length);
      const name=assets.get(suffix);
      if(!name){respond(404,errorPage(404,'Preview not found'));return;}
      const data=await readFile(resolve(root,name));
      respond(200,data,mime[name.split('.').at(-1)]);
    }catch{respond(503,errorPage(503,'The preview is temporarily unavailable'));}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PREVIEW_PORT??4796);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid preview port');
  const server=createPreviewServer();server.maxHeadersCount=32;server.headersTimeout=10000;server.requestTimeout=10000;
  server.listen(port,'127.0.0.1',()=>console.log(`Agent analytics preview listening on 127.0.0.1:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>process.exit(0));server.closeAllConnections();});
}
