// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {GatewayBootstrapClient,decodeBootstrap,OpenCodeClient} from '@ai4s/sdk';

const page={items:[],nextCursor:null,revision:1,directoryPaths:{}};
const valid={schema:1,account:{id:'alice',displayName:'Alice'},policyRevision:3,
 assistant:{runtime:'codex',label:'Codex',enabled:true,defaultModel:'gpt-6.1',capabilities:{prompt:true,files:true}},
 catalog:{state:'ready',revision:1},projects:page,conversations:page,
 workspace:{context:{instanceId:'user-alice',generation:1},state:'healthy',activity:'unknown',canRestart:false,retryAfterMs:0}};

it('validates authenticated bootstrap without accepting malformed identities or directory escapes',()=>{
 expect(decodeBootstrap(valid).account.id).toBe('alice');
 expect(()=>decodeBootstrap({...valid,policyRevision:0})).toThrow();
 expect(()=>decodeBootstrap({...valid,workspace:{...valid.workspace,context:{instanceId:'user-alice',generation:0}}})).toThrow();
 expect(()=>decodeBootstrap({...valid,conversations:{...page,directoryPaths:{owned:'../foreign'}}})).toThrow();
});
it('binds the existing account signal and never retries a failed bootstrap request',async()=>{
 const controller=new AbortController();
 const fetchImpl=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  expect(init?.credentials).toBe('same-origin');return new Response(JSON.stringify(valid));
 });
 const client=new GatewayBootstrapClient({baseUrl:'https://workbench.example',fetchImpl});
 expect((await client.read({signal:controller.signal,timeoutMs:1000})).assistant.runtime).toBe('codex');
 expect(fetchImpl).toHaveBeenCalledOnce();
 controller.abort();
 await expect(client.read({signal:controller.signal,timeoutMs:1000})).rejects.toThrow();
 expect(fetchImpl).toHaveBeenCalledOnce();
});

it('waits for a matching healthy workspace acknowledgement before marking the event stream ready',async()=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;
 const body=new ReadableStream<Uint8Array>({start(controller){stream=controller;}});
 const client=new OpenCodeClient({workspaceCatalogRoot:'/workspace',fetchImpl:vi.fn(async()=>new Response(body)),connectTimeoutMs:1000});
 client.setGatewayGeneration(1);client.setGatewayAssistantRevision(3);
 let ready=false;const connecting=client.connect().then(()=>{ready=true;});
 await new Promise(resolve=>setTimeout(resolve,10));expect(ready).toBe(false);
 stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:'workspace.bootstrap',properties:{accountId:'alice',policyRevision:3,catalogRevision:1,workspace:valid.workspace}})}\n\n`));
 await connecting;expect(client.getStatus()).toBe('ready');client.close();stream.close();
});
