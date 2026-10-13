import {workspaceError} from './workspace-state.mjs';
export function createWorkspaceRoutes({management,readJson,sendJson,secureCookies=false}) {
  return {async handle(request,response,context){
    const url=new URL(request.url,'http://platform.invalid'),path=url.pathname;
    if(!path.startsWith('/api/workspace/'))return false;
    try {
      const method=request.method;
      if(!['GET','HEAD'].includes(method)){
        if(context.readOnly)throw workspaceError('read_only',403);
        if(request.headers.origin!==`${secureCookies?'https':'http'}://${request.headers.host}` || request.headers['sec-fetch-site']==='cross-site')throw workspaceError('foreign_origin',403);
      }
      const body=!['GET','HEAD'].includes(method)?await readJson(request,response):{};
      if(body===null)return true;
      if(!body || typeof body!=='object' || Array.isArray(body))throw workspaceError('invalid_input',400);
      let result;
      const project=path.match(/^\/api\/workspace\/projects\/([a-f0-9]{16})(?:\/(trash))?$/);
      const restore=path.match(/^\/api\/workspace\/trash\/([a-f0-9]{16})\/restore$/);
      const session=path.match(/^\/api\/workspace\/sessions\/([A-Za-z0-9_-]{1,128})\/state$/);
      const receipt=path.match(/^\/api\/workspace\/operations\/([A-Za-z0-9_-]{1,128})$/);
      if(method==='GET' && session)result=await management.sessionState(context,session[1]);
      else if(method==='GET' && path==='/api/workspace/projects')result=await management.listProjects(context);
      else if(method==='GET' && path==='/api/workspace/trash')result=await management.listTrash(context);
      else if(method==='GET' && receipt)result=await management.state.receipt(context.userId,receipt[1]);
      else if(method==='GET' && path==='/api/workspace/entries'){
        for(const key of url.searchParams.keys())if(!['scope','path'].includes(key) || url.searchParams.getAll(key).length!==1)throw workspaceError('invalid_input',400);
        let scope;try{scope=JSON.parse(url.searchParams.get('scope'));}catch{throw workspaceError('invalid_scope',400);}
        result=await management.entries(context,scope,url.searchParams.get('path')??'');
      }
      else if(method==='PATCH' && project && !project[2]){
        if(Object.keys(body).some(key=>!['name','pinned','operationId'].includes(key)))throw workspaceError('invalid_input',400);
        result=await management.patchProject(context,project[1],body);
      }
      else if(method==='POST' && project?.[2])result=await management.trashProject(context,project[1],body);
      else if(method==='POST' && restore)result=await management.restore(context,restore[1],body);
      else throw workspaceError('not_found',404);
      sendJson(response,200,result);
    }catch(error){sendJson(response,error.statusCode??503,{error:error.statusCode?error.message:'Workspace management unavailable',code:error.code??'workspace_unavailable'});}
    return true;
  }};
}
