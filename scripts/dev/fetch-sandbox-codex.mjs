import {createHash} from "node:crypto";
import {mkdir,open,rm,lstat} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";

// Fixed Linux build and npm integrity, measured again in the attested image.
const version="0.157.1";
const integrity="Eac8XlC0nCXSeUjDU9l8yLJ6P9evv1mO+AnvILoNwlegBC7B3AVXqJ05QcMhQX7RcJ3Lk2618ykCb2X2ui8VAQ==";
if(process.env.CI!=="true" || process.argv.length!==2)throw new Error("fixed CI Codex staging required");
const directory=resolve(".deploy/science-context/tools/bin");await mkdir(directory,{recursive:true});
const response=await fetch(`https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-x64.tgz`,{redirect:"error",signal:AbortSignal.timeout(120000)});
if(!response.ok)throw new Error("pinned native runtime download unavailable");
const path=resolve(".deploy/science-context/codex-download.tgz");
try {
  const descriptor=await open(path,"wx",0o600);const hash=createHash("sha512");let size=0;
  try {
    for await(const value of response.body){size+=value.byteLength;
      if(size>200*1024**2)throw new Error("native archive limit");
      hash.update(value);await descriptor.writeFile(value);
    }
    await descriptor.sync();
  }finally{await descriptor.close();}
  if(hash.digest("base64")!==integrity)throw new Error("native archive integrity mismatch");
  const extract=spawnSync("python3",["-c",`import os,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 member=archive.getmember('package/vendor/x86_64-unknown-linux-musl/bin/codex')
 if not member.isfile() or member.size>400*1024**2:raise ValueError('invalid native archive')
 source=archive.extractfile(member)
 with open(sys.argv[2], 'xb') as target:
  while chunk:=source.read(1024*1024):target.write(chunk)
 os.chmod(sys.argv[2],0o755)
`,path,`${directory}/codex`],{stdio:"inherit",timeout:30000});
  if(extract.status!==0 || !(await lstat(`${directory}/codex`)).isFile())throw new Error("native binary staging failed");
}finally{await rm(path,{force:true});}
