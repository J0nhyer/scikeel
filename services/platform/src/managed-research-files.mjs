import {createHash} from "node:crypto";
import {posix} from "node:path";
import {relativeInput} from "./tenant-policy.mjs";

export class ManagedResearchFiles {
  #queue=Promise.resolve(); #pending=0;
  constructor({files,tenantPolicy,resolveContext}) {Object.assign(this,{files,tenantPolicy,resolveContext});}
  async #owned(owner,path) {
    const context=await this.resolveContext(owner.userId);const account=this.tenantPolicy.account(context);
    const session=this.tenantPolicy.session(context,owner.sessionId);
    if(context.userId!==owner.userId || session.directory!==owner.directory || account.workspaceDir!==owner.workspaceDir)
      throw Object.assign(new Error("research workspace identity changed"),{status:403});
    const prefix=posix.relative(account.workspaceDir,session.directory);
    return {context,path:path===undefined ? prefix : posix.join(prefix,relativeInput(path))};
  }
  #serialized(run) {
    if(this.#pending>=64)return Promise.reject(new Error("research file capacity unavailable"));
    this.#pending++;const result=this.#queue.then(run);this.#queue=result.catch(()=>{});
    return result.finally(()=>{this.#pending--;});
  }
  async normalize(owner) {
    const {context,path}=await this.#owned(owner);
    await this.#serialized(()=>this.files.call(context,{operation:"list",root:"workspace",path}));
    return {directory:owner.directory,workspaceDir:owner.workspaceDir};
  }
  async prepare(owner) {
    const {context,path}=await this.#owned(owner,".scikeel");
    return this.#serialized(()=>this.files.call(context,{operation:"mkdirAll",root:"workspace",path}));
  }
  async readReport(owner,path) {
    const owned=await this.#owned(owner,path);
    try {
      const result=await this.#serialized(()=>this.files.call(owned.context,{operation:"read",root:"workspace",path:owned.path}));
      return typeof result.text==="string" && Buffer.byteLength(result.text)<=128*1024 ? result.text : null;
    } catch {return null;}
  }
  async artifact(owner,path) {
    const owned=await this.#owned(owner,path);
    return this.#serialized(async()=>{
      try {
        const hash=createHash("sha256");let offset=0;let expected;
        do {
          const result=await this.files.call(owned.context,{operation:"readChunk",root:"workspace",path:owned.path,offset,limit:256*1024});
          if(result.offset!==offset || !Number.isSafeInteger(result.size) || result.size<0 || result.size>25*1024**2 ||
              !Array.isArray(result.bytes) || result.bytes.length>256*1024 || result.bytes.some(byte=>!Number.isInteger(byte)||byte<0||byte>255) ||
              (expected!==undefined && result.size!==expected) || (!result.bytes.length && offset<result.size))throw new Error("invalid research file response");
          expected=result.size;const bytes=Buffer.from(result.bytes);offset+=bytes.length;
          if(offset>expected)throw new Error("research file changed");hash.update(bytes);
        }while(offset<expected);
        return {path,exists:true,sha256:hash.digest("hex")};
      } catch{return {path,exists:false,sha256:null};}
    });
  }
}
