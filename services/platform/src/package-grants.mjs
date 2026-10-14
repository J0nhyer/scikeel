import { randomBytes, createHash } from "node:crypto";

const hash=(token)=>createHash("sha256").update(token).digest("hex");
const normalize=(name)=>name.toLowerCase().replace(/[-_.]+/g,"-");
function identity(context) {
  if(!context || ![context.userId,context.instanceId].every(value=>typeof value==="string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
      !Number.isSafeInteger(context.generation) || context.generation<1)throw new Error("invalid package capability identity");
  return `${context.userId}:${context.instanceId}:${context.generation}`;
}
export class PackageGrants {
  #records=new Map();
  constructor({now=Date.now,maxRequests=1000,maxGrants=1000}={}) {
    if(typeof now!=="function" || !Number.isSafeInteger(maxRequests) || maxRequests<1 || maxRequests>1000 ||
        !Number.isSafeInteger(maxGrants) || maxGrants<1 || maxGrants>10000)throw new Error("invalid package capability limits");
    Object.assign(this,{now,maxRequests,maxGrants});
  }
  // This method is called only after the platform consumes a manual install approval.
  issue(context) {
    const owner=identity(context);
    if(!Number.isSafeInteger(context.expiresAt) || context.expiresAt<=this.now() || context.expiresAt>this.now()+600000 ||
        !Array.isArray(context.packages) || !context.packages.length || context.packages.length>200 ||
        context.packages.some(name=>typeof name!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)))throw new Error("invalid package capability");
    for(const [key,record]of this.#records)if(record.expiresAt<=this.now())this.#records.delete(key);
    if(this.#records.size>=this.maxGrants)throw new Error("package capability capacity");
    const token=randomBytes(32).toString("hex");
    this.#records.set(hash(token),{owner,expiresAt:context.expiresAt,packages:new Set(context.packages.map(normalize)),requests:0});return token;
  }
  authorize(context,route,token) {
    let owner;try{owner=identity(context);}catch{return false;}
    if(typeof token!=="string" || !/^[a-f0-9]{64}$/.test(token))return false;
    const record=this.#records.get(hash(token));
    if(!record || record.owner!==owner || record.expiresAt<=this.now() || record.requests>=this.maxRequests || !route)return false;
    let name;
    if(route.kind==="index")name=route.package;
    else if(route.kind==="archive") {
      const file=route.path.split("/").at(-1);
      name=file.endsWith(".whl") ? file.split("-")[0] : /^(.+)-[0-9][A-Za-z0-9_.+!-]*\.(?:zip|tar\.(?:gz|bz2|xz))$/.exec(file)?.[1];
    }
    if(!name || !record.packages.has(normalize(name)))return false;
    record.requests++;return true;
  }
  revoke(token) { if (typeof token === "string") this.#records.delete(hash(token)); }
  revokeContext(context) {const owner=identity(context);for(const[key,record]of this.#records)if(record.owner===owner)this.#records.delete(key);}
}
