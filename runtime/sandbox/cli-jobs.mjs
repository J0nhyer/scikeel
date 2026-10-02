import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { posix } from "node:path";

function path(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || /[\0\\]/.test(value) ||
      posix.normalize(value) !== value || value.endsWith("/")) throw new Error("invalid private job path");
  return value;
}
export function buildJobEnvironment({ privateHome, projectDir, environment, brokers = {} }) {
  path(privateHome); path(projectDir);
  if (!environment || !["base", "private"].includes(environment.kind) ||
      environment.python !== (environment.kind === "base" ? "/opt/scikeel/science/bin/python" : `${projectDir}/.venv/bin/python`))
    throw new Error("unverified Python environment");
  const allowed = new Set(["modelUrl", "modelToken", "packageToken", "egressToken"]);
  if (Object.keys(brokers).some((key) => !allowed.has(key)) || (brokers.modelUrl !== undefined && brokers.modelUrl !== "http://172.31.240.1:4792/v1") ||
      ["modelToken", "packageToken", "egressToken"].some((key) => brokers[key] !== undefined && !/^[a-f0-9]{64}$/.test(brokers[key])))
    throw new Error("untrusted job broker configuration");
  const env = { PATH: `${posix.dirname(environment.python)}:/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: privateHome, LANG: "C.UTF-8", TMPDIR: "/tmp", UV_CACHE_DIR: `${privateHome}/.cache/uv`,
    XDG_CONFIG_HOME: `${privateHome}/.config`, XDG_CACHE_HOME: `${privateHome}/.cache`, XDG_DATA_HOME: `${privateHome}/.local/share`,
    MPLCONFIGDIR: `${privateHome}/.cache/matplotlib`, UV_PYTHON_DOWNLOADS: "never", UV_LINK_MODE: "copy",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1",
    NO_PROXY: "localhost,127.0.0.1,172.31.240.1", no_proxy: "localhost,127.0.0.1,172.31.240.1" };
  const proxy = brokers.egressToken ? `http://scikeel:${brokers.egressToken}@172.31.240.1:4794` : "http://172.31.240.1:4794";
  env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxy;
  if (brokers.packageToken) {
    env.UV_INDEX_URL = env.PIP_INDEX_URL = `http://scikeel:${brokers.packageToken}@172.31.240.1:4793/root/pypi/+simple/`;
    env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  }
  if (brokers.modelToken) {
    env.OPENAI_API_KEY = brokers.modelToken; env.OPENAI_BASE_URL = "http://172.31.240.1:4792/v1";
  }
  return env;
}
// OpenCode's pinned shell.env hook receives a per-session project directory.
// Inspection runs inside the sandbox before each shell tool; a broken override
// must remain an explicit repair error instead of selecting a different Python.
export class ScienceEnvironmentHooks {
  constructor({manifest,directory,imageDigest,inspector}) {
    path(manifest?.workspaceDir);path(manifest?.home);path(directory);
    if(!/^sha256:[a-f0-9]{64}$/.test(imageDigest??"") || typeof inspector?.call!=="function" ||
        (directory!==manifest.workspaceDir && !directory.startsWith(`${manifest.workspaceDir}/`)))
      throw new Error("invalid project shell environment");
    Object.assign(this,{manifest,directory,imageDigest,inspector});
  }
  async apply(input,output) {
    path(input?.cwd);
    if(input.cwd!==this.directory && !input.cwd.startsWith(`${this.directory}/`))throw new Error("foreign shell working directory");
    let environment={kind:"base",python:"/opt/scikeel/science/bin/python"};
    if(this.directory!==this.manifest.workspaceDir) {
      const info=await this.inspector.call({operation:"inspect",project:posix.relative(this.manifest.workspaceDir,this.directory),imageDigest:this.imageDigest});
      if(info.owned!==true || info.projectDir!==this.directory || info.imageDigest!==this.imageDigest || !["absent","valid"].includes(info.venvState))
        throw new Error("project Python environment needs repair");
      environment=info.venvState==="valid" ? {kind:"private",python:info.venvPython} : {kind:"base",python:info.basePython};
    }
    const selected=buildJobEnvironment({privateHome:this.manifest.home,projectDir:this.directory,environment});
    for(const key of ["PATH","PYTHONNOUSERSITE","PYTHONDONTWRITEBYTECODE","UV_PYTHON_DOWNLOADS","UV_LINK_MODE","UV_CACHE_DIR",
      "OMP_NUM_THREADS","OPENBLAS_NUM_THREADS","MKL_NUM_THREADS","NUMEXPR_NUM_THREADS","MPLCONFIGDIR"])output.env[key]=selected[key];
    output.env.VIRTUAL_ENV=environment.kind==="private" ? `${this.directory}/.venv` : "";
  }
}

export function runtimeArgv({ runtime, model, sessionId }) {
  // Only the pinned OpenCode runtime is present in science-v1. Native CLI modes
  // remain unavailable until their approval protocol passes sandbox acceptance.
  if (runtime !== "opencode" || typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(model) ||
      (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))) throw new Error("managed runtime unavailable");
  return ["/opt/scikeel/tools/bin/opencode", "run", "--format", "json", "--model", model, ...(sessionId ? ["--session", sessionId] : [])];
}

// One private native app-server per turn. All argv/configuration is fixed here;
// callers cannot send a host command or choose a different transport endpoint.
export class CodexAppServer {
  #child; #pending=new Map(); #approvals=new Map(); #next=1; #buffer=""; #bytes=0; #closed=false; #thread; #turn; #closing;
  constructor({spawnImpl,emit,onStopped=()=>{},timeoutMs=1200000,requestTimeoutMs=30000}) {
    if(typeof spawnImpl!=="function" || typeof emit!=="function" || typeof onStopped!=="function" || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>1200000 ||
        !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs<1 || requestTimeoutMs>30000)throw new Error("invalid native turn configuration");
    Object.assign(this,{spawnImpl,emit,onStopped,timeoutMs,requestTimeoutMs});
  }
  #write(value) {
    if(this.#closed || !this.#child?.stdin.writable)throw new Error("native runtime unavailable");
    const bytes=JSON.stringify(value)+"\n";
    if(Buffer.byteLength(bytes)>1024**2 || this.#child.stdin.writableLength>2*1024**2)throw new Error("native input limit");
    this.#child.stdin.write(bytes);
  }
  #request(method,params) {
    if(this.#pending.size>=32)return Promise.reject(new Error("native request capacity"));
    const id=this.#next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error("native request timeout"));void this.close();},this.requestTimeoutMs);
      this.#pending.set(id,{resolve,reject,timer});
      try {this.#write({id,method,params});}catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error);}
    });
  }
  async start({privateHome,projectDir,environment,brokers,model,text,images=[],nativeSessionId,signal}) {
    if(this.#child || this.#closed || typeof model!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(model) || typeof text!=="string" ||
        Buffer.byteLength(text)>512*1024 || !Array.isArray(images) || images.length>10 ||
        images.some(url=>typeof url!=="string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(url)) ||
        (nativeSessionId!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(nativeSessionId)) || signal?.aborted)
      throw new Error("invalid native turn");
    const env=buildJobEnvironment({privateHome,projectDir,environment,brokers});
    if(!brokers.modelToken)throw new Error("native model capability required");
    env.CODEX_HOME=posix.join(posix.dirname(privateHome),"codex-home");
    const args=["app-server","--listen","stdio://","-c",'model_provider="scikeel"',"-c",
      'model_providers.scikeel={name="SciKeel",base_url="http://172.31.240.1:4792/v1",env_key="OPENAI_API_KEY",wire_api="responses"}',
      "-c",'approval_policy="untrusted"',"-c",'sandbox_mode="read-only"',"-c",'web_search="disabled"'];
    this.#child=this.spawnImpl("/opt/scikeel/tools/bin/codex",args,{cwd:projectDir,env,detached:true,stdio:["pipe","pipe","pipe"]});
    const child=this.#child;child.stdin.on("error",()=>{});child.stderr.resume();
    const decoder=new StringDecoder("utf8");
    this.redact=value=>String(value).replaceAll(brokers.modelToken,"[redacted]").replaceAll(privateHome,"[private home]");
    let queue=Promise.resolve();
    child.stdout.on("data",chunk=>{
      this.#bytes+=chunk.length;this.#buffer+=decoder.write(chunk);
      if(this.#bytes>32*1024**2 || Buffer.byteLength(this.#buffer)>2*1024**2){void this.close();return;}
      child.stdout.pause();
      queue=queue.then(async()=>{
        let boundary;
        while((boundary=this.#buffer.indexOf("\n"))!==-1) {
          const line=this.#buffer.slice(0,boundary);this.#buffer=this.#buffer.slice(boundary+1);
          if(Buffer.byteLength(line)>1024**2)throw new Error("native output limit");
          if(line.trim())await this.#message(JSON.parse(line));
        }
      }).then(()=>{if(!this.#closed)child.stdout.resume();}).catch(()=>{void this.close();});
    });
    child.once("error",()=>{void this.close();});
    child.once("close",()=>{void this.close();});
    this.deadline=setTimeout(()=>{void this.close();},this.timeoutMs);
    this.abort=()=>{void this.close();};this.signal=signal;signal?.addEventListener("abort",this.abort,{once:true});
    if(signal?.aborted){await this.close();throw new Error("native turn cancelled");}
    try {
      await this.#request("initialize",{clientInfo:{name:"scikeel",version:"1.0.0"}});
      this.#write({method:"initialized"});
      const params={model,modelProvider:"scikeel",cwd:projectDir,approvalPolicy:"untrusted",sandbox:"read-only"};
      const thread=await this.#request(nativeSessionId ? "thread/resume" : "thread/start",{...params,...(nativeSessionId?{threadId:nativeSessionId}:{})});
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(thread.thread?.id??"") || (nativeSessionId && thread.thread.id!==nativeSessionId))throw new Error("native resume identity changed");
      this.#thread=thread.thread.id;
      const turn=await this.#request("turn/start",{threadId:this.#thread,cwd:projectDir,model,approvalPolicy:"untrusted",
        sandboxPolicy:{type:"readOnly",networkAccess:false},input:[{type:"text",text},...images.map(url=>({type:"image",url}))]});
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(turn.turn?.id??""))throw new Error("native turn identity unavailable");
      this.#turn=turn.turn.id;
      signal?.removeEventListener("abort",this.abort);this.signal=undefined;
      return {nativeSessionId:this.#thread,turnId:this.#turn};
    } catch {await this.close();throw new Error("native turn unavailable");}
  }
  async #message(value) {
    if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("invalid native frame");
    if(value.id!==undefined && !value.method) {
      const pending=this.#pending.get(value.id);if(!pending)throw new Error("unknown native reply");
      this.#pending.delete(value.id);clearTimeout(pending.timer);
      value.error ? pending.reject(new Error("native request failed")) : pending.resolve(value.result);return;
    }
    if(typeof value.method!=="string")throw new Error("invalid native event");
    const params=value.params??{};
    if(params.threadId && this.#thread && params.threadId!==this.#thread)throw new Error("foreign native thread");
    if(params.turnId && this.#turn && params.turnId!==this.#turn)throw new Error("foreign native turn");
    if(value.id!==undefined) {
      if(!["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(value.method) ||
          !["string","number"].includes(typeof value.id) || this.#approvals.size>=32 || this.#approvals.has(String(value.id))) {
        this.#write({id:value.id,error:{code:-32601,message:"Native capability unavailable"}});return;
      }
      if(!this.#thread || params.threadId!==this.#thread || typeof params.turnId!=="string")throw new Error("invalid native approval scope");
      const id=String(value.id);this.#approvals.set(id,{rpcId:value.id,threadId:params.threadId,turnId:params.turnId});
      await this.emit({type:"approval",id,kind:value.method.includes("commandExecution")?"command":"edit",command:params.command ? this.redact(params.command) : null});return;
    }
    if(value.method==="item/agentMessage/delta" && typeof params.delta==="string")await this.emit({type:"text",text:this.redact(params.delta)});
    else if(value.method==="item/commandExecution/outputDelta" && typeof params.delta==="string")await this.emit({type:"tool-output",text:this.redact(params.delta)});
    else if(value.method==="turn/completed") {
      await this.emit({type:"completed",status:params.turn?.status==="completed"?"completed":"failed"});await this.close();
    }
  }
  approve({id,decision}) {
    if(!["accept","decline","cancel"].includes(decision))throw new Error("invalid native approval decision");
    const record=this.#approvals.get(id);if(!record)throw new Error("native approval unavailable");
    this.#approvals.delete(id);this.#write({id:record.rpcId,result:{decision}});
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closed=true;clearTimeout(this.deadline);this.signal?.removeEventListener("abort",this.abort);
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(new Error("native runtime stopped"));}
    this.#pending.clear();this.#approvals.clear();const child=this.#child;
    this.#closing=(async()=>{
      if(!child || child.exitCode!==null || child.signalCode!==null)return;
      const stopped=new Promise(resolve=>child.once("close",resolve));
      try{process.kill(-child.pid,"SIGTERM");}catch{child.kill("SIGTERM");}
      const timer=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}},2000);
      await stopped;clearTimeout(timer);
    })().then(()=>{this.onStopped();});
    return this.#closing;
  }
}

export function jobRequest(value) {
  const fields={start:["operation","sessionId","project","model","text","images","nativeSessionId"],
    events:["operation","jobId","after"],approve:["operation","jobId","id","decision"],abort:["operation","jobId"]};
  const allowed=fields[value?.operation];
  if(!value || typeof value!=="object" || Array.isArray(value) || !allowed || Object.keys(value).some(key=>!allowed.includes(key)))
    throw new Error("invalid managed job operation");
  if(value.operation==="start") {
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId??"") || typeof value.project!=="string" || !value.project || value.project.length>4096 ||
        /[\\\0]/.test(value.project) || value.project.startsWith("/") || value.project.split("/").some(part=>["",".",".."].includes(part)) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value.model??"") || typeof value.text!=="string" || Buffer.byteLength(value.text)>512*1024 ||
        (value.nativeSessionId!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(value.nativeSessionId)) ||
        (value.images!==undefined && (!Array.isArray(value.images) || value.images.length>10 || value.images.some(url=>typeof url!=="string" ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(url) || Buffer.byteLength(url)>768*1024))))throw new Error("invalid managed job input");
  } else {
    if(!/^[a-f0-9]{64}$/.test(value.jobId??""))throw new Error("invalid managed job identity");
    if(value.operation==="events" && (!Number.isSafeInteger(value.after) || value.after<0))throw new Error("invalid managed event cursor");
    if(value.operation==="approve" && (!/^[a-f0-9]{64}$/.test(value.id??"") || !["accept","decline","cancel"].includes(value.decision)))
      throw new Error("invalid managed job approval");
  }
  return {...value};
}
export class CliJobs {
  #jobs=new Map(); #starting=false;
  constructor({manifest,environments,imageDigest,spawnImpl=spawn,nativeFactory=options=>new CodexAppServer(options)}) {
    if(!manifest || !environments || !/^sha256:[a-f0-9]{64}$/.test(imageDigest??"") || typeof nativeFactory!=="function")throw new Error("invalid managed jobs integration");
    Object.assign(this,{manifest,environments,imageDigest,spawnImpl,nativeFactory});
  }
  configure(profile) {this.profile=profile;}
  get busy() {return this.#starting || [...this.#jobs.values()].some(job=>["running","settling"].includes(job.status));}
  async call(value,{signal}={}) {
    const request=jobRequest(value);
    if(signal?.aborted)throw new Error("managed job request cancelled");
    if(request.operation==="start")return this.#start(request,signal);
    const job=this.#jobs.get(request.jobId);if(!job)throw new Error("managed job not found");
    if(request.operation==="abort"){await job.native.close();job.status="cancelled";return {stopped:true};}
    if(request.operation==="approve") {
      const pending=job.approvals.get(request.id);if(!pending || job.status!=="running")throw new Error("managed approval unavailable");
      job.approvals.delete(request.id);job.native.approve({id:pending,decision:request.decision});return {replied:true};
    }
    if(request.after>job.sequence || (job.events.length && request.after<job.events[0].sequence-1))throw new Error("managed event cursor unavailable");
    return {jobId:job.id,status:job.status,nativeSessionId:job.nativeSessionId,events:job.events.filter(event=>event.sequence>request.after)};
  }
  async #start(request,signal) {
    if(this.busy)throw new Error("managed job capacity unavailable");
    if(!this.profile)throw new Error("managed job profile unavailable");
    const providerName=this.profile.enabled_providers[0];const provider=this.profile.provider[providerName];
    // Codex requires a Responses-compatible broker. Anthropic-only profiles stay unavailable.
    if(provider.npm!=="@ai-sdk/openai-compatible" || !Object.hasOwn(provider.models,request.model))throw new Error("managed native model unavailable");
    this.#starting=true;
    try {
      const info=await this.environments.call({operation:"inspect",project:request.project,imageDigest:this.imageDigest},{signal});
      const projectDir=`${this.manifest.workspaceDir}/${request.project}`;
      if(info.owned!==true || info.projectDir!==projectDir || !["absent","valid"].includes(info.venvState))throw new Error("managed project environment unavailable");
      const environment=info.venvState==="valid" ? {kind:"private",python:info.venvPython} : {kind:"base",python:info.basePython};
      if(this.#jobs.size>=16){const oldest=[...this.#jobs].find(([,job])=>job.status!=="running");if(oldest)this.#jobs.delete(oldest[0]);}
      if(this.#jobs.size>=16)throw new Error("managed job history capacity");
      const job={id:randomBytes(32).toString("hex"),sessionId:request.sessionId,status:"running",events:[],sequence:0,bytes:0,approvals:new Map()};
      job.native=this.nativeFactory({spawnImpl:this.spawnImpl,onStopped:()=>{
        if(job.status==="running"){job.status="failed";job.approvals.clear();}
      },emit:async event=>{
        if(event.type==="approval") {
          if(job.approvals.size>=32)throw new Error("managed approval capacity");
          const id=randomBytes(32).toString("hex");job.approvals.set(id,event.id);event={...event,id};
        }
        const owned={...event,sessionID:job.sessionId,sequence:++job.sequence};
        job.bytes+=Buffer.byteLength(JSON.stringify(owned));if(job.bytes>2*1024**2)throw new Error("managed event output limit");
        job.events.push(owned);
        if(event.type==="completed"){job.status="settling";job.approvals.clear();await job.native.close();job.status=event.status;}
      }});
      this.#jobs.set(job.id,job);
      try {
        const result=await job.native.start({...request,privateHome:this.manifest.home,projectDir,environment,
          brokers:{modelToken:provider.options.apiKey,modelUrl:provider.options.baseURL},signal});
        job.nativeSessionId=result.nativeSessionId;return {jobId:job.id,nativeSessionId:result.nativeSessionId};
      } catch {await job.native.close();job.status="failed";job.approvals.clear();throw new Error("managed native turn unavailable");}
    } finally{this.#starting=false;}
  }
  async close() {await Promise.allSettled([...this.#jobs.values()].map(job=>job.native.close()));this.#jobs.clear();}
}
