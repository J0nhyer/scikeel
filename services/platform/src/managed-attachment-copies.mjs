import { createHash, randomBytes } from "node:crypto";
import { open, constants } from "node:fs/promises";
import { posix } from "node:path";

const denied=()=>Object.assign(new Error("attachment copy unavailable"),{status:409});
const identifier=value=>typeof value==="string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
// Originals stay in the platform store. Only bounded, owner-authorized working
// copies cross the runner protocol; no platform path is mounted in a tenant.
export class ManagedAttachmentCopies {
  constructor({files,tenantPolicy,resolveContext}) {
    if(!files || !tenantPolicy || typeof resolveContext!=="function")throw new Error("invalid attachment copy integration");
    Object.assign(this,{files,tenantPolicy,resolveContext});
  }
  async materialize({userId,sessionId,files,signal}) {
    if(!identifier(userId) || !identifier(sessionId) || !Array.isArray(files) || files.length>10)throw denied();
    const context=await this.resolveContext(userId);
    if(context.userId!==userId)throw denied();
    const owner=this.tenantPolicy.account(context);this.tenantPolicy.session(context,sessionId);
    const directory=`.scikeel/attachments/${sessionId}`;
    await this.files.call(context,{operation:"mkdirAll",root:"workspace",path:directory},{signal});
    const result=[];
    try {
    for(const file of files) {
      if(!identifier(file.id) || !Number.isSafeInteger(file.size) || file.size<0 || file.size>25*1024**2 ||
          !/^[a-f0-9]{64}$/.test(file.sha256??"") || typeof file.name!=="string" || Buffer.byteLength(file.name)>240 ||
          /[\\/\0]/.test(file.name) || typeof file.sourcePath!=="string" || !posix.isAbsolute(file.sourcePath))throw denied();
      // The random copy name prevents partial transfers or edited older copies
      // from being mistaken for the immutable uploaded bytes of this turn.
      let name=file.name.replace(/[^\p{L}\p{N}._-]/gu,"_");
      while(Buffer.byteLength(name)>140)name=name.slice(0,-1);
      const path=`${directory}/${file.id}-${randomBytes(12).toString("hex")}-${name}`;
      let source;
      try {
        source=await open(file.sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const stat=await source.stat();if(!stat.isFile() || stat.size!==file.size)throw denied();
        const hash=createHash("sha256");let offset=0;
        do {
          if(signal?.aborted)throw denied();
          const buffer=Buffer.alloc(Math.min(256*1024,file.size-offset));
          const {bytesRead}=await source.read(buffer,0,buffer.length,offset);
          if(bytesRead!==buffer.length)throw denied();
          hash.update(buffer);
          await this.files.call(context,{operation:"writeChunk",root:"workspace",path,offset,bytes:[...buffer]},{signal});
          offset+=bytesRead;
        } while(offset<file.size);
        if(hash.digest("hex")!==file.sha256)throw denied();
        const {sourcePath:_source,...publicFile}=file;
        result.push({...publicFile,path:`${owner.workspaceDir}/${path}`,workDir:`${owner.workspaceDir}/${directory}`});
      } catch {
        await this.files.call(context,{operation:"remove",root:"workspace",path}).catch(()=>{});
        throw denied();
      } finally {await source?.close();}
    }
    return result;
    } catch(error) {
      for(const file of result)await this.files.call(context,{operation:"remove",root:"workspace",path:posix.relative(owner.workspaceDir,file.path)}).catch(()=>{});
      throw error;
    }
  }
}
