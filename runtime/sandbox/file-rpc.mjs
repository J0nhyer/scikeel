import { spawn } from "node:child_process";
import { posix } from "node:path";
export const managementStatuses={entry_not_found:404,name_conflict:409,revision_conflict:409,entry_unavailable:403};

export function fileRequest(value) {
  const fields = { read:["operation","root","path"], list:["operation","root","path"], listStrict:["operation","root","path"], mkdir:["operation","root","path"],
    mkdirAll:["operation","root","path"], remove:["operation","root","path"], write:["operation","root","path","text"],
    readChunk:["operation","root","path","offset","limit"], writeChunk:["operation","root","path","offset","bytes"],
    stat:["operation","root","path"],snapshot:["operation","root","path"],readText:["operation","root","path"],createText:["operation","root","path","text"],
    moveNoReplace:["operation","root","path","destinationPath","expectedRevision"],
    replaceTextFromStaging:["operation","root","path","destinationPath","expectedRevision","expectedSourceRevision"],
    saveTextIfRevision:["operation","root","path","text","expectedRevision"] };
  const allowed = fields[value?.operation];
  if (!value || typeof value !== "object" || Array.isArray(value) || !allowed || Object.keys(value).some(key => !allowed.includes(key)) ||
      value.root !== "workspace" || typeof value.path !== "string" || value.path.length > 4096 || /[\0\\]/.test(value.path) ||
      value.path.startsWith("/") || posix.normalize(value.path || ".") !== (value.path || ".") || value.path.split("/").some(part => part === "..") ||
      (value.operation === "write" && (typeof value.text !== "string" || Buffer.byteLength(value.text) > 1024 ** 2)) ||
      (["createText","saveTextIfRevision"].includes(value.operation) && (typeof value.text!=="string" || value.text.includes('\0') || Buffer.byteLength(value.text)>2*1024**2)) ||
      (["moveNoReplace","saveTextIfRevision","replaceTextFromStaging"].includes(value.operation) && !/^[a-f0-9]{64}$/.test(value.expectedRevision??"")) ||
      (value.operation==='replaceTextFromStaging' && (!/^[a-f0-9]{64}$/.test(value.expectedSourceRevision??'') || !value.path.startsWith('.scikeel/workspace-management/staging/') || !value.path.endsWith('/payload'))) ||
      (["moveNoReplace","replaceTextFromStaging"].includes(value.operation) && (typeof value.destinationPath!=="string" || !value.destinationPath || value.destinationPath.length>4096 || /[\0\\]/.test(value.destinationPath) || value.destinationPath.startsWith("/") || posix.normalize(value.destinationPath)!==value.destinationPath || value.destinationPath.split("/").some(part=>["",".",".."].includes(part)))) ||
      (["readChunk","writeChunk"].includes(value.operation) && (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 25*1024**2)) ||
      (value.operation === "readChunk" && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 256*1024)) ||
      (value.operation === "writeChunk" && (!Array.isArray(value.bytes) || value.bytes.length > 256*1024 || value.offset+value.bytes.length > 25*1024**2 ||
        value.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)))) throw new Error("file operation denied");
  return {...value};
}
export class FileRpc {
  constructor({ spawnImpl = spawn, timeoutMs = 15000, maxOutputBytes = 16 * 1024 ** 2 } = {}) {
    if (typeof spawnImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 ** 2) throw new Error("invalid file helper configuration");
    Object.assign(this, { spawnImpl, timeoutMs, maxOutputBytes });
  }
  call(value, { signal } = {}) {
    let request;
    try { request = fileRequest(value); if (signal?.aborted) throw new Error("file helper cancelled"); }
    catch (error) { return Promise.reject(error); }
    return this.execute(request, "/opt/scikeel/tools/bin/osd", ["managed-file-rpc"], { signal });
  }
  execute(request, command, args, { signal } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnImpl(command, args, {
        detached: true, env: { PATH: "/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
      }); } catch { reject(new Error("file helper unavailable")); return; }
      let reason; let count = 0; const output = [];
      function stop(error) {
        if (reason) return; reason = error;
        if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }
      const abort = () => stop(new Error("file helper cancelled"));
      const timer = setTimeout(() => stop(new Error("file helper timeout")), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk) => {
        count += chunk.length;
        if (count > this.maxOutputBytes) stop(new Error("file helper output limit")); else output.push(chunk);
      });
      child.stderr.resume(); child.stdin.on("error", () => {});
      child.on("error", () => { reason ??= new Error("file helper unavailable"); });
      child.once("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (reason || code !== 0) { reject(reason ?? new Error("file operation denied")); return; }
        let value;try {value=JSON.parse(Buffer.concat(output).toString("utf8"));}catch {reject(new Error("invalid file helper response"));return;}
        if(value?.error){const code=value.error.code;reject(Object.assign(new Error(Object.hasOwn(managementStatuses,code)?code:'file operation denied'),Object.hasOwn(managementStatuses,code)?{code,statusCode:managementStatuses[code]}:{}));return;}
        resolve(value);
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
export function environmentRequest(value) {
  if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!["operation","project","inputHash","imageDigest","packageToken","stageId"].includes(key)) ||
      !["inspect","stage","publish","discard"].includes(value.operation) || !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest??"") ||
      typeof value.project!=="string" || !value.project || value.project.length>4096 || /[\0\\]/.test(value.project) || value.project.startsWith("/") ||
      value.project.split("/").some(part=>["",".",".."].includes(part)) ||
      (value.operation!=="inspect" && !/^[a-f0-9]{64}$/.test(value.inputHash??"")) ||
      (value.operation==="stage" ? !/^[a-f0-9]{64}$/.test(value.packageToken??"") : Object.hasOwn(value,"packageToken")) ||
      (["publish","discard"].includes(value.operation) ? !/^[a-f0-9]{64}$/.test(value.stageId??"") : Object.hasOwn(value,"stageId")))
    throw new Error("environment operation denied");
  return {...value};
}
export class EnvironmentRpc extends FileRpc {
  constructor(options={}) {super({timeoutMs:300000,maxOutputBytes:2*1024**2,...options});}
  call(value,{signal}={}) {
    let request;try{request=environmentRequest(value);if(signal?.aborted)throw new Error("environment helper cancelled");}
    catch(error){return Promise.reject(error);}
    return this.execute(request,"/opt/scikeel/science/bin/python",["-I","/opt/scikeel/tools/project-environment.py"],{signal});
  }
}
