import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { PackageBroker } from "../../services/platform/src/package-broker.mjs";

const binary=resolve(".deploy/package-mirror-fixture/venv/bin");
const store=await mkdtemp(join(tmpdir(),"scikeel-mirror-probe-"));
const archive=Buffer.from("synthetic-public-wheel-content");
const digest=createHash("sha256").update(archive).digest("hex");
let downloads=0; let child;
const upstream=createServer((req,res)=>{
  if(req.url==="/simple/") {res.writeHead(503);res.end("Full public package inventory must not be fetched");}
  else if(req.url==="/simple/scikeel-fixture/") {res.setHeader("content-type","text/html");res.end(`<a href="/public/scikeel_fixture-1.0-py3-none-any.whl#sha256=${digest}">fixture</a>`);}
  else if(req.url==="/public/scikeel_fixture-1.0-py3-none-any.whl") {downloads++;res.setHeader("content-type","application/octet-stream");res.setHeader("content-length",archive.length);res.end(archive);}
  else {res.writeHead(404);res.end();}
});
const contexts={a:{userId:"a",instanceId:"sandbox-test-a",generation:1},b:{userId:"b",instanceId:"sandbox-test-b",generation:1}};
let activeUser="a";
const broker=new PackageBroker({mirrorUrl:"http://127.0.0.1:3142",identify:(address)=>address==="127.0.0.1" ? contexts[activeUser] : null,
  authorize:(context,_route,token)=>context?.userId===token,timeoutMs:5000});
try {
  await new Promise((done)=>upstream.listen(0,"127.0.0.1",done));
  const init=spawnSync(join(binary,"devpi-init"),["--serverdir",store,"--root-passwd","synthetic-fixture-only"],{encoding:"utf8",timeout:15000});
  if(init.status!==0)throw new Error("mirror fixture initialization failed");
  const configure=spawnSync(join(binary,"python"),[resolve("services/platform/fixtures/configure-mirror.py"),store,`http://127.0.0.1:${upstream.address().port}/simple/`],{encoding:"utf8",timeout:15000});
  if(configure.status!==0)throw new Error("mirror fixture configuration failed");
  child=spawn(join(binary,"devpi-server"),["--serverdir",store,"--host","127.0.0.1","--port","3142","--threads","2"],{detached:true,stdio:["ignore","ignore","ignore"]});
  let ready=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline && child.exitCode===null) {
    try {if((await fetch("http://127.0.0.1:3142/+status",{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}
    await new Promise((done)=>setTimeout(done,100));
  }
  if(!ready)throw new Error("real public mirror unavailable");
  await broker.listen({host:"127.0.0.1",port:0});const base=`http://127.0.0.1:${broker.server.address().port}`;
  for(const user of ["a","b"]) {
    activeUser=user;
    const headers={authorization:`Bearer ${user}`,"x-synthetic-user":user};
    const index=await fetch(`${base}/root/pypi/+simple/scikeel-fixture/`,{headers});
    if(!index.ok)throw new Error("real package broker index rejected");
    const html=await index.text();const link=/href="([^"]+)"/.exec(html)?.[1];
    if(!link?.startsWith("/root/pypi/+f/"))throw new Error("mirror archive not scoped");
    const response=await fetch(`${base}${link.split("#")[0]}`,{headers});
    if(!response.ok || !Buffer.from(await response.arrayBuffer()).equals(archive))throw new Error("mirror archive mismatch");
    const upload=await fetch(`${base}/root/pypi/`,{method:"POST",headers,body:"denied"});
    if(upload.status!==403)throw new Error("package upload accepted");
  }
  if(downloads!==1)throw new Error("public archive was fetched more than once");
  console.log(JSON.stringify({synthetic:true,realDevpi:true,tenants:2,upstreamArchiveDownloads:downloads,uploadsDenied:true}));
} finally {
  await broker.close();upstream.closeAllConnections();await new Promise((done)=>upstream.close(done));
  if(child && child.exitCode===null && child.signalCode===null) {
    const stopped=new Promise((done)=>child.once("close",done));
    try{process.kill(-child.pid,"SIGTERM");}catch{}
    const timer=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},3000);await stopped;clearTimeout(timer);
  }
  await rm(store,{recursive:true,force:true});
}
