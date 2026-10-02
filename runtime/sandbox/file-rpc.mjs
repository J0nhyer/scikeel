import { spawn } from "node:child_process";
import { posix } from "node:path";

export function fileRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["operation", "root", "path", "text"].includes(key)) ||
      !["read", "write", "list", "mkdir"].includes(value.operation) || value.root !== "workspace" ||
      typeof value.path !== "string" || value.path.length > 4096 || /[\0\\]/.test(value.path) ||
      value.path.startsWith("/") || posix.normalize(value.path || ".") !== (value.path || ".") ||
      value.path.split("/").some((part) => part === "..") ||
      (value.operation === "write" ? typeof value.text !== "string" || Buffer.byteLength(value.text) > 2 * 1024 ** 2 : Object.hasOwn(value, "text")))
    throw new Error("file operation denied");
  return { ...value };
}
export class FileRpc {
  constructor({ spawnImpl = spawn, timeoutMs = 15000, maxOutputBytes = 4 * 1024 ** 2 } = {}) {
    if (typeof spawnImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 8 * 1024 ** 2) throw new Error("invalid file helper configuration");
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
        try { resolve(JSON.parse(Buffer.concat(output).toString("utf8"))); } catch { reject(new Error("invalid file helper response")); }
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
