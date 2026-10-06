// Only this factory is exported: OpenCode loads every module export as a plugin.
import {collaborationHooks} from "./collaboration.mjs";
import {lstat,readFile} from "node:fs/promises";
import {ScienceEnvironmentHooks} from "./cli-jobs.mjs";
import {EnvironmentRpc} from "./file-rpc.mjs";
export default async function scienceEnvironment({directory},{imageDigest,collaborationToken}={}) {
  const metadata=await lstat("/opt/scikeel/tenant.json");
  if(!metadata.isFile() || metadata.uid!==0 || metadata.mode&0o022 || metadata.size>65536)
    throw new Error("untrusted tenant environment manifest");
  const manifest=JSON.parse(await readFile("/opt/scikeel/tenant.json","utf8"));
  const hooks=new ScienceEnvironmentHooks({manifest,directory,imageDigest,inspector:new EnvironmentRpc({timeoutMs:10000})});
  let collaboration;
  if(collaborationToken){
    collaboration=collaborationHooks({token:collaborationToken});
    const response=await fetch("http://172.31.240.1:4792/collaboration",{method:"POST",headers:{authorization:`Bearer ${collaborationToken}`,"content-type":"application/json"},body:JSON.stringify({action:"capability",sessionId:"capability"}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error("Collaboration runtime registration failed");
  }
  return {...(collaboration?{tool:collaboration.tool,"experimental.chat.system.transform":collaboration["experimental.chat.system.transform"]}:{}),"shell.env":(input,output)=>hooks.apply(input,output),
    "tool.execute.before":async(input,output)=>{await collaboration?.["tool.execute.before"](input,output);await hooks.beforeTool(input,output);}};
}
