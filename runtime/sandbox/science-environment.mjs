// Only this factory is exported: OpenCode loads every module export as a plugin.
import {lstat,readFile} from "node:fs/promises";
import {ScienceEnvironmentHooks} from "./cli-jobs.mjs";
import {EnvironmentRpc} from "./file-rpc.mjs";
export default async function scienceEnvironment({directory},{imageDigest}={}) {
  const metadata=await lstat("/opt/scikeel/tenant.json");
  if(!metadata.isFile() || metadata.uid!==0 || metadata.mode&0o022 || metadata.size>65536)
    throw new Error("untrusted tenant environment manifest");
  const manifest=JSON.parse(await readFile("/opt/scikeel/tenant.json","utf8"));
  const hooks=new ScienceEnvironmentHooks({manifest,directory,imageDigest,inspector:new EnvironmentRpc({timeoutMs:10000})});
  return {"shell.env":(input,output)=>hooks.apply(input,output),
    "tool.execute.before":(input,output)=>hooks.beforeTool(input,output)};
}
