import {createHash} from "node:crypto";
import {mkdir,writeFile,rm,lstat} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";

// Fixed Linux build and npm integrity, measured again in the attested image.
const version="0.157.1";
const integrity="Eac8XlC0nCXSeUjDU9l8yLJ6P9evv1mO+AnvILoNwlegBC7B3AVXqJ05QcMhQX7RcJ3Lk2618ykCb2X2ui8VAQ==";
if(process.env.CI!=="true" || process.argv.length!==2)throw new Error("fixed CI Codex staging required");
const directory=resolve(".deploy/science-context/tools/bin");await mkdir(directory,{recursive:true});
const response=await fetch(`https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-x64.tgz`,{redirect:"error",signal:AbortSignal.timeout(120000)});
if(!response.ok)throw new Error("pinned native runtime download unavailable");
const reader=response.body.getReader();const chunks=[];let size=0;
for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>100*1024**2){await reader.cancel();throw new Error("native archive limit");}chunks.push(Buffer.from(value));}
const archive=Buffer.concat(chunks);if(createHash("sha512").update(archive).digest("base64")!==integrity)throw new Error("native archive integrity mismatch");
const path=resolve(".deploy/science-context/codex-download.tgz");await writeFile(path,archive,{flag:"wx",mode:0o600});
try {
  const extract=spawnSync("python3",["-c",`import io,os,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 member=archive.getmember('package/vendor/x86_64-unknown-linux-musl/bin/codex')
 if not member.isfile() or member.size>200*1024**2:raise ValueError('invalid native archive')
 source=archive.extractfile(member)
 with open(sys.argv[2], 'xb') as target:
  while chunk:=source.read(1024*1024):target.write(chunk)
 os.chmod(sys.argv[2],0o755)
`,path,`${directory}/codex`],{stdio:"inherit",timeout:30000});
  if(extract.status!==0 || !(await lstat(`${directory}/codex`)).isFile())throw new Error("native binary staging failed");
}finally{await rm(path,{force:true});}
