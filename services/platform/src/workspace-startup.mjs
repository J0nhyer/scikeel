export async function prepareWorkspaceService({migrate,manager,authStore,platform,workspaceCatalog,logger=()=>{}}){
 if(migrate){
  if(!workspaceCatalog)throw new Error('workspace catalog service unavailable');
  let needsImport=true;
  for(const user of await authStore.listUsers()){
   try{await platform.catalogProjector.drain(user.id);await workspaceCatalog.snapshot(user.id,{limit:1});}
   catch(error){if(error.code!=='catalog_recovering')throw error;needsImport=true;}
  }
  if(needsImport){const report=await platform.importWorkspaceCatalog();logger({type:'catalog.imported',report});}
  return {mode:'migrate'};
 }
 const result=await manager?.retireUnmanagedInstances?.()??{retired:[],blocked:[]};
 logger({type:'workspace.startup_cleanup',adopted:0,retired:result.retired?.length??0,blocked:result.blocked?.length??0});
 return {mode:'serve'};
}
