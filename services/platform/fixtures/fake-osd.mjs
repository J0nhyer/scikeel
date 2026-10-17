import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const args = process.argv.slice(2);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const port = Number(value("--port"));
const token = value("--token");
const workspace = value("--workspace");
const stateDir = value("--state-dir");

if (!port || !token || !workspace || !stateDir) {
  console.error("fake osd: missing required server arguments");
  process.exit(2);
}

const projects = [];
const managedHistory = [];
const canonicalSessions=new Map();
let managedPermission = [];
const server = createServer(async (request, response) => {
  if (request.url === "/v1/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "fake-osd" }));
    return;
  }
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`worker:${workspace}`);
    return;
  }
  const expectedBasic = `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`;
  if (request.url === "/echo") {
    if (request.headers.authorization !== expectedBasic) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "expected basic auth" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie ?? null,
    }));
    return;
  }
  if (request.url?.startsWith("/event")) {
    if (request.headers.authorization !== expectedBasic) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "expected basic auth" }));
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      query: request.url,
    }));
    return;
  }
  const runtimeUrl=new URL(request.url,"http://worker.invalid");
  if(runtimeUrl.pathname==='/session'&&request.method==='POST'&&request.headers.authorization===expectedBasic){
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const id=`ses_canonical_${canonicalSessions.size+1}`,session={id,title:body.title,directory:runtimeUrl.searchParams.get('directory')??workspace,permission:body.permission??[]};
    canonicalSessions.set(id,{session,history:[]});response.setHeader('content-type','application/json');response.end(JSON.stringify(session));return;
  }
  if(request.method==='GET'&&['/session/status','/permission','/question','/experimental/session'].includes(runtimeUrl.pathname)){
    if(request.headers.authorization!==expectedBasic){response.writeHead(401);response.end();return;}
    response.setHeader('content-type','application/json');response.end(JSON.stringify(runtimeUrl.pathname==='/session/status'?{}:
      runtimeUrl.pathname==='/experimental/session'?[...canonicalSessions.values()].map(value=>value.session):[]));return;
  }
  if(runtimeUrl.pathname.startsWith("/session/")) {
    if(request.headers.authorization!==expectedBasic){response.writeHead(401);response.end();return;}
    response.setHeader("content-type","application/json");
    const native=/^\/session\/([A-Za-z0-9_-]+)(?:\/(message|prompt_async|children|abort))?$/.exec(runtimeUrl.pathname),owned=canonicalSessions.get(native?.[1]);
    if(owned){
      let body={};if(['POST','PATCH'].includes(request.method)){const chunks=[];for await(const chunk of request)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
      if(!native[2]){if(body.permission)owned.session.permission=body.permission;response.end(JSON.stringify(owned.session));return;}
      if(native[2]==='message'&&request.method==='GET'){response.end(JSON.stringify(owned.history));return;}
      if(native[2]==='children'){response.end('[]');return;}
      if(native[2]==='abort'){response.end('true');return;}
      if(['prompt_async','message'].includes(native[2])&&request.method==='POST'){
        owned.history.push({info:{id:body.messageID,role:'user',sessionID:owned.session.id},parts:body.parts,fixtureSystem:body.system,fixturePermission:owned.session.permission});
        if(!body.noReply)owned.history.push({info:{id:`msg_answer_${owned.history.length}`,role:'assistant',sessionID:owned.session.id,time:{completed:1}},parts:[{type:'text',text:'OpenCode continued with actual fixture history'}]});
        response.writeHead(202);response.end('{}');return;
      }
    }
    const match=/^\/session\/([A-Za-z0-9_-]+)(?:\/(message|prompt_async)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(runtimeUrl.pathname);
    if(!match || match[1]!=="owned"){response.writeHead(404);response.end();return;}
    if(!match[2]){
      if(request.method === "PATCH") {
        const buffers=[];for await(const chunk of request)buffers.push(chunk);
        const body=JSON.parse(Buffer.concat(buffers).toString());
        if(body.permission)managedPermission=body.permission;
      }
      response.end(JSON.stringify({id:match[1],directory:workspace+"/project",permission:managedPermission}));return;
    }
    if(match[2]==="message" && request.method==="GET"){
      const message = match[3] ? managedHistory.find(item => item.info.id === match[3]) : managedHistory;
      if (!message) { response.writeHead(404); response.end("{}"); return; }
      response.end(JSON.stringify(message));return;
    }
    if(match[2]==="prompt_async" && request.method==="POST") {
      const buffers=[];for await(const chunk of request)buffers.push(chunk);
      const body=JSON.parse(Buffer.concat(buffers).toString());
      managedHistory.push({info:{id:body.messageID,role:"user"},parts:body.parts,fixtureSystem:body.system,fixturePermission:managedPermission});
      response.writeHead(202);response.end("{}");return;
    }
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (request.url === "/v1/whoami") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      directory: workspace,
      mode: "full",
      stateDir,
    }));
    return;
  }
  const parsed = new URL(request.url, "http://worker.invalid");
  if (parsed.pathname === "/v1/projects") {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      const buffers = []; for await (const chunk of request) buffers.push(chunk);
      const { name } = JSON.parse(Buffer.concat(buffers).toString());
      if (typeof name !== "string" || !name.trim()) { response.writeHead(400); response.end("{}"); return; }
      const id = `project-${projects.length + 1}`;
      const path = resolve(workspace, "projects", id);
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, "scope.txt"), id);
      const project = { id, name: name.trim(), path, createdAt: Date.now(), imported: false, pinned: false };
      projects.push(project); response.end(JSON.stringify(project));
    } else response.end(JSON.stringify(projects));
    return;
  }
  if (parsed.pathname === "/v1/fs/read") {
    const full = resolve(parsed.searchParams.get("dir") ?? workspace, parsed.searchParams.get("path") ?? "");
    if (!full.startsWith(`${resolve(workspace)}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const content = await readFile(full);
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake worker ready on ${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
