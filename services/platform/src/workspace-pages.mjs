import {workspaceError,workspaceHash} from './workspace-state.mjs';

export function workspacePage(items,{limit=100,cursor}={},binding,key){
 if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Array.isArray(items) || items.length>20000)throw workspaceError('invalid_input',400);
 const scope=workspaceHash(binding);let after;
 if(cursor!==undefined){
  try{
   if(typeof cursor!=='string' || cursor.length>8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
   const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
   if(decoded.scope!==scope || typeof decoded.after!=='string' || decoded.after.length>4096)throw new Error();after=decoded.after;
  }catch{throw workspaceError('invalid_cursor',400);}
 }
 const sorted=items.filter(item=>after===undefined || key(item)>after).sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0),page=sorted.slice(0,limit);
 return {items:page,nextCursor:sorted.length>limit?Buffer.from(JSON.stringify({scope,after:key(page.at(-1))})).toString('base64url'):null};
}
export function workspacePageQuery(url,allowed=[]){
 for(const key of url.searchParams.keys())if(![...allowed,'limit','cursor'].includes(key) || url.searchParams.getAll(key).length!==1)throw workspaceError('invalid_input',400);
 const limit=url.searchParams.get('limit');if(limit!==null && !/^[1-9]\d*$/.test(limit))throw workspaceError('invalid_input',400);
 return {...(limit!==null?{limit:Number(limit)}:{}),...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{})};
}
