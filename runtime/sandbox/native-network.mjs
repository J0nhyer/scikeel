import {FileRpc} from './file-rpc.mjs';

export function networkStepRequest(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['tool','url','query','grant','expiresAt'].includes(key))||
  !['webfetch','websearch'].includes(value.tool)||typeof value.url!=='string'||value.url.length>2048||/[\0\r\n]/.test(value.url)||
  !/^[a-f0-9]{64}$/.test(value.grant??'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+120000)
  throw Error('Native network step denied');
 const url=new URL(value.url);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.hash||
  (value.tool==='websearch'?(value.url!=='https://search.parallel.ai/mcp'||typeof value.query!=='string'||!value.query.trim()||value.query.length>4096):value.query!==undefined))
  throw Error('Native network destination denied');
 return structuredClone(value);
}
export class NativeNetworkRpc extends FileRpc {
 constructor(options={}){super({timeoutMs:120000,maxOutputBytes:1024**2,...options});}
 call(value,{signal}={}){
  let request;try{request=networkStepRequest(value);signal?.throwIfAborted();}catch(error){return Promise.reject(error);}
  return this.execute(request,'/opt/scikeel/science/bin/python',['-I','/opt/scikeel/tools/native-network.py'],{signal});
 }
}
