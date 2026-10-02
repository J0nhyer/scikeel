import { posix } from "node:path";

function canonical(path) {
  return typeof path === "string" && path.startsWith("/") && path !== "/" && !/[\0\\]/.test(path) && posix.normalize(path) === path && !path.endsWith("/");
}
// This record must come from secure inspection inside the tenant, never from a public request.
export function selectPythonEnvironment(info) {
  if (!info || info.owned !== true || !canonical(info.projectDir)) throw new Error("environment is outside the owned project");
  if (!/^sha256:[a-f0-9]{64}$/.test(info.imageDigest ?? "") || info.basePython !== "/opt/scikeel/science/bin/python")
    throw new Error("unverified scientific baseline");
  if (info.venvState === "absent") return Object.freeze({ kind: "base", python: info.basePython, imageDigest: info.imageDigest });
  if (info.venvState !== "valid" || info.venvPython !== `${info.projectDir}/.venv/bin/python`)
    throw new Error("private environment is invalid; approve a rebuild");
  return Object.freeze({ kind: "private", python: info.venvPython, imageDigest: info.imageDigest });
}

function projectKey(context) {
  if (!context || !["userId","instanceId","projectId","sessionId"].every((key)=>typeof context[key]==="string" && /^[A-Za-z0-9_-]{1,128}$/.test(context[key])) ||
      !Number.isSafeInteger(context.generation) || context.generation<1) throw new Error("invalid environment identity");
  return `${context.userId}:${context.instanceId}:${context.generation}:${context.projectId}`;
}
export class ProjectEnvironments {
  #installing = new Set(); #leases = new Map(); #records = new Map();
  constructor({ approvals, files }) {
    if (!approvals || !files || !["inspect","stage","publish","discard"].every((key)=>typeof files[key]==="function"))
      throw new Error("invalid environment integration");
    Object.assign(this,{approvals,files});
  }
  retain(context) {
    const key=projectKey(context);
    if(this.#installing.has(key)) throw new Error("project environment is busy");
    this.#leases.set(key,(this.#leases.get(key)??0)+1);let released=false;
    return Object.freeze({release:()=>{if(released)return;released=true;const count=this.#leases.get(key)-1;
      count ? this.#leases.set(key,count) : this.#leases.delete(key);}});
  }
  record(context) {return this.#records.get(projectKey(context))??null;}
  async install(request,{signal}={}) {
    const key=projectKey(request);
    if(this.#installing.has(key) || this.#leases.has(key)) throw new Error("project environment is busy");
    if(signal?.aborted) throw new Error("environment install cancelled");
    this.#installing.add(key);let staged;let published=false;
    try {
      // Secure inspection is performed by the sandbox adapter, never the host filesystem.
      const previous=await this.files.inspect(request,{signal});
      if(previous.owned!==true || !canonical(previous.projectDir) || previous.inputHash!==request.inputHash)
        throw new Error("environment input changed");
      this.approvals.consume(request);
      staged=await this.files.stage(request,{signal});
      if(signal?.aborted) throw new Error("environment install cancelled");
      if(!staged || !/^[A-Za-z0-9_-]{1,128}$/.test(staged.stageId??"") || staged.inputHash!==request.inputHash ||
          staged.imageDigest!==previous.imageDigest || !/^sha256:[a-f0-9]{64}$/.test(staged.imageDigest??"") ||
          !/^[a-f0-9]{64}$/.test(staged.lockHash??"") || staged.standalone!==true || staged.stableInterpreter!==true || staged.validated!==true ||
          !Array.isArray(staged.inventory) || staged.inventory.length>10000 || staged.inventory.some((entry)=>
            !entry || Object.keys(entry).sort().join(",")!=="name,version" || typeof entry.name!=="string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.name) ||
            typeof entry.version!=="string" || !/^[A-Za-z0-9_.+!-]{1,128}$/.test(entry.version)))
        throw new Error("unverified private environment");
      const current=await this.files.inspect(request,{signal});
      if(current.owned!==true || current.projectDir!==previous.projectDir || current.inputHash!==request.inputHash) throw new Error("environment input changed");
      // publish must be an atomic sandbox-side transaction, including rollback on validation failure.
      const installed=await this.files.publish(request,{stageId:staged.stageId,inputHash:request.inputHash,signal});
      const selection=selectPythonEnvironment(installed);
      if(selection.kind!=="private" || installed.projectDir!==previous.projectDir || selection.imageDigest!==staged.imageDigest)
        throw new Error("unverified private environment publication");
      published=true;
      const record=Object.freeze({schema:1,imageDigest:staged.imageDigest,lockHash:staged.lockHash,kind:"private",
        inventory:Object.freeze(staged.inventory.map((entry)=>Object.freeze({...entry})))});
      this.#records.set(key,record);return {selection,record};
    } finally {
      try {if(staged && !published) await this.files.discard(request,{stageId:staged.stageId});}
      finally {this.#installing.delete(key);}
    }
  }
}
