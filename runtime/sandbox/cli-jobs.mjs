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
  beforeTool(input, output) {
    // OpenCode 1.18.32 cannot serialize a pending webfetch permission whose
    // metadata contains timeout: undefined. Fill the default before asking;
    // the existing manual permission gate still owns network authorization.
    if (input.tool !== "webfetch" || !output.args || typeof output.args !== "object") return;
    if (output.args.timeout === undefined) output.args.timeout = 60;
  }

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
const nativeTurnEvents=new Set(["item/tool/requestUserInput","item/commandExecution/requestApproval",
  "item/fileChange/requestApproval","item/agentMessage/delta","item/commandExecution/outputDelta","turn/completed"]);
export class CodexAppServer {
  #child; #pending=new Map(); #approvals=new Map(); #questions=new Map(); #next=1; #buffer=""; #bytes=0; #closed=false; #thread; #turn; #closing; #exited;
  #startingTurn=false; #deferredEvents=[];
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
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error("native request timeout"));void this.close().catch(()=>{});},this.requestTimeoutMs);
      this.#pending.set(id,{resolve,reject,timer});
      try {this.#write({id,method,params});}catch(error){clearTimeout(timer);this.#pending.delete(id);reject(error);}
    });
  }
  async start({privateHome,projectDir,environment,brokers,model,text,images=[],nativeSessionId,effort,signal}) {
    if(this.#child || this.#closed || typeof model!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(model) || typeof text!=="string" ||
        Buffer.byteLength(text)>512*1024 || !Array.isArray(images) || images.length>10 ||
        images.some(url=>typeof url!=="string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(url)) ||
        (nativeSessionId!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(nativeSessionId)) ||
        (effort!==undefined&&(typeof effort!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)))||signal?.aborted)
      throw new Error("invalid native turn");
    const env=buildJobEnvironment({privateHome,projectDir,environment,brokers});
    if(!brokers.modelToken)throw new Error("native model capability required");
    env.CODEX_HOME=posix.join(posix.dirname(privateHome),"codex-home");
    const args=["app-server","--listen","stdio://","-c",'model_provider="scikeel"',"-c",
      'model_providers.scikeel={name="SciKeel",base_url="http://172.31.240.1:4792/v1",env_key="OPENAI_API_KEY",wire_api="responses"}',
      "-c",'approval_policy="on-request"',"-c",'sandbox_mode="read-only"',"-c",'web_search="disabled"'];
    this.#child=this.spawnImpl("/opt/scikeel/tools/bin/codex",args,{cwd:projectDir,env,detached:true,stdio:["pipe","pipe","pipe"]});
    const child=this.#child;this.#exited=new Promise(resolve=>child.once("close",resolve));
    child.stdin.on("error",()=>{});child.stderr.resume();
    const decoder=new StringDecoder("utf8");
    this.redact=value=>String(value).replaceAll(brokers.modelToken,"[redacted]").replaceAll(privateHome,"[private home]");
    let queue=Promise.resolve();
    child.stdout.on("data",chunk=>{
      this.#bytes+=chunk.length;this.#buffer+=decoder.write(chunk);
      if(this.#bytes>32*1024**2 || Buffer.byteLength(this.#buffer)>2*1024**2){void this.close().catch(()=>{});return;}
      child.stdout.pause();
      queue=queue.then(async()=>{
        let boundary;
        while((boundary=this.#buffer.indexOf("\n"))!==-1) {
          const line=this.#buffer.slice(0,boundary);this.#buffer=this.#buffer.slice(boundary+1);
          if(Buffer.byteLength(line)>1024**2)throw new Error("native output limit");
          if(line.trim())await this.#message(JSON.parse(line));
        }
      }).then(()=>{if(!this.#closed)child.stdout.resume();}).catch(()=>{void this.close().catch(()=>{});});
    });
    child.once("error",()=>{void this.close().catch(()=>{});});
    child.once("close",()=>{void this.close().catch(()=>{});});
    this.deadline=setTimeout(()=>{void this.close().catch(()=>{});},this.timeoutMs);
    this.abort=()=>{void this.close().catch(()=>{});};this.signal=signal;signal?.addEventListener("abort",this.abort,{once:true});
    if(signal?.aborted){await this.close();throw new Error("native turn cancelled");}
    try {
      await this.#request("initialize",{clientInfo:{name:"scikeel",version:"1.0.0"}});
      this.#write({method:"initialized"});
      const params={model,modelProvider:"scikeel",cwd:projectDir,approvalPolicy:"on-request",sandbox:"read-only"};
      const thread=await this.#request(nativeSessionId ? "thread/resume" : "thread/start",{...params,...(nativeSessionId?{threadId:nativeSessionId}:{})});
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(thread.thread?.id??"") || (nativeSessionId && thread.thread.id!==nativeSessionId))throw new Error("native resume identity changed");
      this.#thread=thread.thread.id;
      this.#startingTurn=true;
      const turn=await this.#request("turn/start",{threadId:this.#thread,cwd:projectDir,model,approvalPolicy:"on-request",
        ...(effort!==undefined?{effort}:{}),
        sandboxPolicy:{type:"readOnly",networkAccess:false},input:[{type:"text",text},...images.map(url=>({type:"image",url}))]});
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(turn.turn?.id??""))throw new Error("native turn identity unavailable");
      this.#turn=turn.turn.id;
      // A notification can share a frame batch with the turn acknowledgement.
      // Keep its order, but grant it no identity until the actual RPC reply is validated.
      while(this.#deferredEvents.length)await this.#event(this.#deferredEvents.shift());
      this.#startingTurn=false;
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
    if(nativeTurnEvents.has(value.method)&&this.#startingTurn) {
      if(this.#deferredEvents.length>=32)throw new Error("native early event capacity");
      this.#deferredEvents.push(value);return;
    }
    return this.#event(value);
  }
  async #event(value) {
    if(this.#closed)throw new Error("native runtime stopped");
    const params=value.params??{};
    if(params.threadId && this.#thread && params.threadId!==this.#thread)throw new Error("foreign native thread");
    if(params.turnId && this.#turn && params.turnId!==this.#turn)throw new Error("foreign native turn");
    const scoped=nativeTurnEvents.has(value.method);
    if(scoped&&(!this.#thread||!this.#turn||params.threadId!==this.#thread||
        (value.method==="turn/completed"?params.turn?.id:params.turnId)!==this.#turn))throw new Error("foreign native execution");
    if(scoped&&value.id!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(params.itemId??""))throw new Error("invalid native item scope");
    const scope={nativeSessionId:this.#thread,turnId:this.#turn};
    if(value.id!==undefined) {
      if(value.method==="item/tool/requestUserInput") {
        if(!["string","number"].includes(typeof value.id) || !this.#thread || params.threadId!==this.#thread || typeof params.turnId!=="string" ||
            this.#questions.size>=8 || this.#questions.has(String(value.id)) || !Array.isArray(params.questions) || !params.questions.length || params.questions.length>3)
          throw new Error("invalid native question scope");
        const ids=new Set();const questions=params.questions.map(question=>{
          if(!question || question.isSecret || typeof question.id!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(question.id) || ids.has(question.id) ||
              typeof question.header!=="string" || question.header.length>128 || typeof question.question!=="string" || question.question.length>4096 ||
              (question.options!=null && (!Array.isArray(question.options) || question.options.length>20)))throw new Error("unsupported native question");
          ids.add(question.id);
          const options=(question.options??[]).map(option=>{
            if(typeof option?.label!=="string" || !option.label || option.label.length>128 || typeof option.description!=="string" || option.description.length>2048)
              throw new Error("unsupported native question option");
            return {label:this.redact(option.label),description:this.redact(option.description)};
          });
          return {header:this.redact(question.header),question:this.redact(question.question),options,custom:question.isOther===true || !options.length,multiple:false};
        });
        const id=String(value.id);this.#questions.set(id,{rpcId:value.id,ids:[...ids]});
        await this.emit({type:"question",id,questions,...scope,itemId:params.itemId});return;
      }
      if(!["item/commandExecution/requestApproval","item/fileChange/requestApproval"].includes(value.method) ||
          !["string","number"].includes(typeof value.id) || this.#approvals.size>=32 || this.#approvals.has(String(value.id))) {
        this.#write({id:value.id,error:{code:-32601,message:"Native capability unavailable"}});return;
      }
      if(!this.#thread || params.threadId!==this.#thread || typeof params.turnId!=="string")throw new Error("invalid native approval scope");
      const id=String(value.id);this.#approvals.set(id,{rpcId:value.id,threadId:params.threadId,turnId:params.turnId});
      await this.emit({type:"approval",id,kind:value.method.includes("commandExecution")?"command":"edit",command:params.command ? this.redact(params.command) : null,...scope,itemId:params.itemId});return;
    }
    if(value.method==="item/agentMessage/delta" && typeof params.delta==="string")await this.emit({type:"text",text:this.redact(params.delta),...scope});
    else if(value.method==="item/commandExecution/outputDelta" && typeof params.delta==="string")await this.emit({type:"tool-output",text:this.redact(params.delta),...scope});
    else if(value.method==="turn/completed") {
      await this.emit({type:"completed",status:params.turn?.status==="completed"?"completed":"failed",...scope});await this.close();
    }
  }
  approve({id,decision}) {
    if(!["accept","decline","cancel"].includes(decision))throw new Error("invalid native approval decision");
    const record=this.#approvals.get(id);if(!record)throw new Error("native approval unavailable");
    this.#approvals.delete(id);this.#write({id:record.rpcId,result:{decision}});
  }
  answer({id,answers,reject=false}) {
    const record=this.#questions.get(id);
    if(!record || typeof reject!=="boolean" || (!reject && (!validAnswers(answers) || answers.length!==record.ids.length)))throw new Error("native question unavailable");
    this.#questions.delete(id);
    this.#write({id:record.rpcId,result:{answers:Object.fromEntries(record.ids.map((key,index)=>[key,{answers:reject?[]:answers[index]}]))}});
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closed=true;clearTimeout(this.deadline);this.signal?.removeEventListener("abort",this.abort);
    for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(new Error("native runtime stopped"));}
    this.#pending.clear();this.#approvals.clear();this.#questions.clear();this.#deferredEvents=[];const child=this.#child;
    this.#closing=(async()=>{
      if(!child)return;
      const signalGroup=signal=>{
        if(!Number.isSafeInteger(child.pid) || child.pid<2)return; // A failed spawn has no process group.
        try{process.kill(-child.pid,signal);}catch(error){if(error.code!=="ESRCH")throw new Error("native cleanup unverified");}
      };
      let escalation;let deadline;
      try {
        // The detached group may outlive its parent; exitCode is not cleanup evidence.
        signalGroup("SIGTERM");
        escalation=setTimeout(()=>{try{signalGroup("SIGKILL");}catch{}},2000);
        await Promise.race([this.#exited,new Promise((_,reject)=>{
          deadline=setTimeout(()=>reject(new Error("native cleanup unverified")),5000);
        })]);
        // A resistant child with closed stdio cannot be forgotten when the parent exits.
        signalGroup("SIGKILL");
      } finally {clearTimeout(escalation);clearTimeout(deadline);}
    })().then(()=>{this.onStopped();});
    return this.#closing;
  }
}

function validAnswers(value) {
  return Array.isArray(value) && value.length>0 && value.length<=3 && value.every(answer=>Array.isArray(answer) && answer.length<=20 &&
    answer.every(text=>typeof text==="string" && text.length<=2000 && !text.includes("\0")));
}
export function jobRequest(value) {
  const fields={start:["operation","sessionId","project","model","text","images","nativeSessionId","turnIdentity","identityRevision","nativeProfile"],
    inspect:["operation"],events:["operation","jobId","after"],approve:["operation","jobId","id","decision"],answer:["operation","jobId","id","answers","reject"],abort:["operation","jobId"]};
  const allowed=fields[value?.operation];
  if(!value || typeof value!=="object" || Array.isArray(value) || !allowed || Object.keys(value).some(key=>!allowed.includes(key)))
    throw new Error("invalid managed job operation");
  if(value.operation==="start") {
    const grant=value.nativeProfile,turn=value.turnIdentity;
    const turnFields=['userId','instanceId','generation','conversationId','execution','requestId','policyRevision','runtime'];
    if(!grant||typeof grant!=='object'||Array.isArray(grant)||Object.keys(grant).some(key=>!['model','modelToken','modelUrl','effort'].includes(key))||
        grant.model!==value.model||!/^[a-f0-9]{64}$/.test(grant.modelToken??'')||grant.modelUrl!=='http://172.31.240.1:4792/v1'||
        grant.effort!==undefined&&(typeof grant.effort!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(grant.effort))||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.identityRevision??'')||!turn||typeof turn!=='object'||Array.isArray(turn)||
        Object.keys(turn).sort().join(',')!==turnFields.sort().join(',')||turn.runtime!=='codex'||turn.conversationId!==value.sessionId||
        !['userId','instanceId','conversationId','requestId'].every(key=>/^[A-Za-z0-9_-]{1,128}$/.test(turn[key]??''))||
        !['generation','execution','policyRevision'].every(key=>Number.isSafeInteger(turn[key])&&turn[key]>0))
      throw new Error('invalid native execution grant');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId??"") || typeof value.project!=="string" || !value.project || value.project.length>4096 ||
        /[\\\0]/.test(value.project) || value.project.startsWith("/") || value.project.split("/").some(part=>["",".",".."].includes(part)) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value.model??"") || typeof value.text!=="string" || Buffer.byteLength(value.text)>512*1024 ||
        (value.nativeSessionId!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(value.nativeSessionId)) ||
        (value.images!==undefined && (!Array.isArray(value.images) || value.images.length>10 || value.images.some(url=>typeof url!=="string" ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(url) || Buffer.byteLength(url)>768*1024))))throw new Error("invalid managed job input");
  } else if(value.operation!=="inspect") {
    if(!/^[a-f0-9]{64}$/.test(value.jobId??""))throw new Error("invalid managed job identity");
    if(value.operation==="events" && (!Number.isSafeInteger(value.after) || value.after<0))throw new Error("invalid managed event cursor");
    if(value.operation==="answer" && (!/^[a-f0-9]{64}$/.test(value.id??"") || (value.reject!==undefined && typeof value.reject!=="boolean") ||
        (value.reject!==true && !validAnswers(value.answers))))throw new Error("invalid managed question reply");
    if(value.operation==="approve" && (!/^[a-f0-9]{64}$/.test(value.id??"") || !["accept","decline","cancel"].includes(value.decision)))
      throw new Error("invalid managed job approval");
  }
  return structuredClone(value);
}
export class CliJobs {
  #jobs=new Map(); #starting=false; #closing=false;
  constructor({manifest,environments,imageDigest,spawnImpl=spawn,nativeFactory=options=>new CodexAppServer(options)}) {
    if(!manifest || !environments || !/^sha256:[a-f0-9]{64}$/.test(imageDigest??"") || typeof nativeFactory!=="function")throw new Error("invalid managed jobs integration");
    Object.assign(this,{manifest,environments,imageDigest,spawnImpl,nativeFactory});
  }
  configure(profile) {this.profile=profile;}
  get busy() {return this.#starting || this.#closing || [...this.#jobs.values()].some(job=>["running","settling"].includes(job.status));}
  async call(value,{signal}={}) {
    const request=jobRequest(value);
    if(signal?.aborted)throw new Error("managed job request cancelled");
    if(request.operation==="inspect")return {busy:this.busy,starting:this.#starting,
      jobs:[...this.#jobs.values()].map(job=>({jobId:job.id,sessionId:job.sessionId,status:job.status}))};
    if(request.operation==="start")return this.#start(request,signal);
    const job=this.#jobs.get(request.jobId);if(!job)throw new Error("managed job not found");
    if(request.operation==="abort"){
      job.status="settling";job.approvals.clear();job.questions.clear();
      await job.native.close();job.status="cancelled";return {stopped:true};
    }
    if(request.operation==="answer") {
      const pending=job.questions.get(request.id);if(!pending || job.status!=="running")throw new Error("managed question unavailable");
      job.questions.delete(request.id);job.native.answer({id:pending,answers:request.answers,reject:request.reject??false});return {replied:true};
    }
    if(request.operation==="approve") {
      const pending=job.approvals.get(request.id);if(!pending || job.status!=="running")throw new Error("managed approval unavailable");
      job.approvals.delete(request.id);job.native.approve({id:pending,decision:request.decision});return {replied:true};
    }
    if(request.after>job.sequence || (job.events.length && request.after<job.events[0].sequence-1))throw new Error("managed event cursor unavailable");
    return {jobId:job.id,status:job.status,nativeSessionId:job.nativeSessionId,turnId:job.turnId,events:job.events.filter(event=>event.sequence>request.after)};
  }
  async #start(request,signal) {
    if(this.busy)throw new Error("managed job capacity unavailable");
    if(request.turnIdentity.instanceId!==this.manifest.instanceId||request.turnIdentity.generation!==this.manifest.generation)
      throw new Error('foreign native execution grant');
    this.#starting=true;
    try {
      const info=await this.environments.call({operation:"inspect",project:request.project,imageDigest:this.imageDigest},{signal});
      const projectDir=`${this.manifest.workspaceDir}/${request.project}`;
      if(info.owned!==true || info.projectDir!==projectDir || !["absent","valid"].includes(info.venvState))throw new Error("managed project environment unavailable");
      const environment=info.venvState==="valid" ? {kind:"private",python:info.venvPython} : {kind:"base",python:info.basePython};
      if(this.#jobs.size>=16){const oldest=[...this.#jobs].find(([,job])=>job.status!=="running");if(oldest)this.#jobs.delete(oldest[0]);}
      if(this.#jobs.size>=16)throw new Error("managed job history capacity");
      const job={id:randomBytes(32).toString("hex"),sessionId:request.sessionId,status:"running",events:[],sequence:0,bytes:0,approvals:new Map(),questions:new Map()};
      job.native=this.nativeFactory({spawnImpl:this.spawnImpl,onStopped:()=>{
        if(job.status==="running"){job.status="failed";job.approvals.clear();job.questions.clear();}
      },emit:async event=>{
        if(job.status!=="running"||!event||!['approval','question','text','tool-output','completed'].includes(event.type)||
            !/^[A-Za-z0-9_-]{1,128}$/.test(event.nativeSessionId??"")||!/^[A-Za-z0-9_-]{1,128}$/.test(event.turnId??"")||
            (request.nativeSessionId&&event.nativeSessionId!==request.nativeSessionId)||
            (job.nativeSessionId&&event.nativeSessionId!==job.nativeSessionId)||(job.turnId&&event.turnId!==job.turnId))
          throw new Error("foreign native event scope");
        job.nativeSessionId=event.nativeSessionId;job.turnId=event.turnId;
        if(event.type==="question") {
          if(job.questions.size>=8)throw new Error("managed question capacity");
          const id=randomBytes(32).toString("hex");job.questions.set(id,event.id);event={...event,id};
        }
        if(event.type==="approval") {
          if(job.approvals.size>=32)throw new Error("managed approval capacity");
          const id=randomBytes(32).toString("hex");job.approvals.set(id,event.id);event={...event,id};
        }
        const owned={...event,sessionID:job.sessionId,sequence:++job.sequence};
        job.bytes+=Buffer.byteLength(JSON.stringify(owned));if(job.bytes>2*1024**2)throw new Error("managed event output limit");
        job.events.push(owned);
        if(event.type==="completed"){job.status="settling";job.approvals.clear();job.questions.clear();await job.native.close();job.status=event.status;}
      }});
      this.#jobs.set(job.id,job);
      try {
        const result=await job.native.start({...request,privateHome:this.manifest.home,projectDir,environment,
          effort:request.nativeProfile.effort,brokers:{modelToken:request.nativeProfile.modelToken,modelUrl:request.nativeProfile.modelUrl},signal});
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(result?.nativeSessionId??"")||!/^[A-Za-z0-9_-]{1,128}$/.test(result.turnId??"")||
            (request.nativeSessionId&&result.nativeSessionId!==request.nativeSessionId)||
            (job.nativeSessionId&&result.nativeSessionId!==job.nativeSessionId)||(job.turnId&&result.turnId!==job.turnId))
          throw new Error("foreign native acceptance scope");
        job.nativeSessionId=result.nativeSessionId;job.turnId=result.turnId;
        return {jobId:job.id,nativeSessionId:job.nativeSessionId,turnId:job.turnId};
      } catch {await job.native.close();job.status="failed";job.approvals.clear();job.questions.clear();throw new Error("managed native turn unavailable");}
    } finally{this.#starting=false;}
  }
  async close() {
    if(this.#starting || this.#closing)throw new Error("managed native cleanup unverified");
    this.#closing=true;
    try {
      const results=await Promise.allSettled([...this.#jobs.values()].map(async job=>{
        job.status="settling";job.approvals.clear();job.questions.clear();await job.native.close();
      }));
      if(results.some(result=>result.status==="rejected"))throw new Error("managed native cleanup unverified");
      this.#jobs.clear();
    }finally{this.#closing=false;}
  }
}
