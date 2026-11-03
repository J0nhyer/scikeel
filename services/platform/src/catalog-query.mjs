import {workspaceError} from './workspace-state.mjs';

const conversationKeys=['limit','cursor','directoryRef','lifecycle','search','projectId','unassigned'];
const projectKeys=['limit','cursor','directoryRef','lifecycle'];

export function catalogQuery(path,params){
 const allowed=path==='/api/workspace/bootstrap'?['limit']
  :path==='/api/workspace/catalog/projects'?projectKeys
  :path==='/api/workspace/catalog/project-counts'?[]
  :conversationKeys;
 const lifecycles=path==='/api/workspace/catalog/projects'
  ?['active','archived','trashed']
  :['active','archived','trashed','any'];
 if([...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))
  throw workspaceError('invalid_catalog_query',400);
 const query=Object.fromEntries(params);
 if(query.limit!==undefined){
  if(!/^[1-9]\d{0,2}$/.test(query.limit))throw workspaceError('invalid_catalog_query',400);
  query.limit=Number(query.limit);
 }
 if(query.unassigned!==undefined){
  if(query.unassigned!=='1')throw workspaceError('invalid_catalog_query',400);
  query.unassigned=true;
 }
 if(query.projectId!==undefined&&query.unassigned)throw workspaceError('invalid_catalog_query',400);
 if(query.search!==undefined&&(query.search.length>512||query.search.includes('\0')))
  throw workspaceError('invalid_catalog_query',400);
 if(query.lifecycle!==undefined&&!lifecycles.includes(query.lifecycle))
  throw workspaceError('invalid_catalog_query',400);
 return query;
}
