import {createHash} from "node:crypto";
import {mkdir,open,rm,lstat} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

// Fixed Linux build and npm integrity, measured again in the attested image.
const version="0.157.1";
const integrity="Eac8XlC0nCXSeUjDU9l8yLJ6P9evv1mO+AnvILoNwlegBC7B3AVXqJ05QcMhQX7RcJ3Lk2618ykCb2X2ui8VAQ==";
export async function extractCodexArchive(archive,directory) {
  await mkdir(`${directory}/codex-resources`,{recursive:true});
  const extract=spawnSync("python3",["-c",`import os,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 entries=[('package/vendor/x86_64-unknown-linux-musl/bin/codex','codex',400*1024**2),
          ('package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap','codex-resources/bwrap',2*1024**2)]
 for name,target,limit in entries:
  matches=[entry for entry in archive.getmembers() if entry.name==name]
  if len(matches)!=1 or not matches[0].isfile() or matches[0].size>limit:raise ValueError('invalid native archive')
 for name,target,limit in entries:
  source=archive.extractfile(name)
  path=os.path.join(sys.argv[2],target)
  with open(path,'xb') as output:
   while chunk:=source.read(1024*1024):output.write(chunk)
  os.chmod(path,0o755)
`,archive,directory],{encoding:"utf8",timeout:30000});
  if(extract.error || extract.status!==0)throw new Error("native binary staging failed");
  for(const name of ["codex","codex-resources/bwrap"])
    if(!(await lstat(`${directory}/${name}`)).isFile())throw new Error("native binary staging failed");
}

async function main() {
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
  await extractCodexArchive(path,directory);
}finally{await rm(path,{force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
