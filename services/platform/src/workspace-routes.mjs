import {workspaceError} from './workspace-state.mjs';
import {WORKSPACE_UPLOAD_CHUNK} from './workspace-uploads.mjs';
async function readUploadChunk(request){
  if(request.headers['content-type']!=='application/octet-stream')throw workspaceError('invalid_content_type',415);
  const declared=request.headers['content-length'];
  if(declared!==undefined && (!/^\d+$/.test(declared) || Number(declared)>WORKSPACE_UPLOAD_CHUNK))throw workspaceError('chunk_too_large',413);
  const chunks=[];let size=0;
  for await(const bytes of request){size+=bytes.length;if(size>WORKSPACE_UPLOAD_CHUNK)throw workspaceError('chunk_too_large',413);chunks.push(bytes);}
  if(declared!==undefined && Number(declared)!==size)throw workspaceError('invalid_content_length',400);
  return Buffer.concat(chunks,size);
}
export function createWorkspaceRoutes({management,files,uploads,readJson,sendJson,secureCookies=false}) {
  return {async handle(request,response,context){
    const url=new URL(request.url,'http://platform.invalid'),path=url.pathname;
    if(!path.startsWith('/api/workspace/'))return false;
    try {
      const method=request.method;
      if(!['GET','HEAD'].includes(method)){
        if(context.readOnly)throw workspaceError('read_only',403);
        if(request.headers.origin!==`${secureCookies?'https':'http'}://${request.headers.host}` || request.headers['sec-fetch-site']==='cross-site')throw workspaceError('foreign_origin',403);
      }
      const upload=path.match(/^\/api\/workspace\/uploads\/([a-f0-9]{32})(?:\/(chunks|commit))?$/);
      if(uploads && method==='PUT' && upload?.[2]==='chunks'){
        if([...url.searchParams.keys()].some(key=>key!=='offset') || url.searchParams.getAll('offset').length!==1 || !/^(0|[1-9]\d*)$/.test(url.searchParams.get('offset')??''))throw workspaceError('invalid_offset',400);
        const result=await uploads.chunk(context,upload[1],Number(url.searchParams.get('offset')),await readUploadChunk(request));sendJson(response,200,result);return true;
      }
      if(upload && url.search)throw workspaceError('invalid_input',400);
      const body=!['GET','HEAD'].includes(method)?await readJson(request,response):{};
      if(body===null)return true;
      if(!body || typeof body!=='object' || Array.isArray(body))throw workspaceError('invalid_input',400);
      let result;
      const project=path.match(/^\/api\/workspace\/projects\/([a-f0-9]{16})(?:\/(trash))?$/);
      const restore=path.match(/^\/api\/workspace\/trash\/([a-f0-9]{16}|[a-f0-9]{32})\/restore$/);
      const session=path.match(/^\/api\/workspace\/sessions\/([A-Za-z0-9_-]{1,128})\/state$/);
      const receipt=path.match(/^\/api\/workspace\/operations\/([A-Za-z0-9_-]{1,128})$/);
      if(uploads && method==='POST' && path==='/api/workspace/uploads')result=await uploads.begin(context,body);
      else if(uploads && method==='GET' && path==='/api/workspace/uploads')result=await uploads.list(context);
      else if(uploads && method==='GET' && upload && !upload[2])result=await uploads.inspect(context,upload[1]);
      else if(uploads && method==='POST' && upload?.[2]==='commit')result=await uploads.commit(context,upload[1],body);
      else if(uploads && method==='DELETE' && upload && !upload[2]){if(Object.keys(body).length)throw workspaceError('invalid_input',400);result=await uploads.cancel(context,upload[1]);}
      else if(method==='GET' && session)result=await management.sessionState(context,session[1]);
      else if(method==='GET' && path==='/api/workspace/projects')result=await management.listProjects(context);
      else if(method==='GET' && path==='/api/workspace/trash')result=[...await management.listTrash(context),...(files?await files.trash(context):[])];
      else if(method==='GET' && receipt)result=files?await files.receipt(context,receipt[1]):await management.state.receipt(context.userId,receipt[1]);
      else if(method==='GET' && path==='/api/workspace/entries'){
        for(const key of url.searchParams.keys())if(!['scope','path'].includes(key) || url.searchParams.getAll(key).length!==1)throw workspaceError('invalid_input',400);
        let scope;try{scope=JSON.parse(url.searchParams.get('scope'));}catch{throw workspaceError('invalid_scope',400);}
        result=await (files??management).entries(context,scope,url.searchParams.get('path')??'');
      }
      else if(method==='POST' && path==='/api/workspace/operations' && files)result=await files.operate(context,body);
      else if(method==='PATCH' && project && !project[2]){
        if(Object.keys(body).some(key=>!['name','pinned','operationId'].includes(key)))throw workspaceError('invalid_input',400);
        result=await management.patchProject(context,project[1],body);
      }
      else if(method==='POST' && project?.[2])result=await management.trashProject(context,project[1],body);
      else if(method==='POST' && restore)result=restore[1].length===32 && files?await files.restore(context,restore[1],body):await management.restore(context,restore[1],body);
      else throw workspaceError('not_found',404);
      sendJson(response,200,result);
    }catch(error){sendJson(response,error.statusCode??503,{error:error.statusCode?error.message:'Workspace management unavailable',code:error.code??'workspace_unavailable'});}
    return true;
  }};
}
