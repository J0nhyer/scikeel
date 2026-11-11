// @vitest-environment node
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test.skipIf(!process.env.OSD_COLLABORATION_BROWSER)(
  "Web collaboration restores an unanswered decision, saves only real answers, and fits phone widths",
  async () => {
    const { chromium } = createRequire(import.meta.url)(
      process.env.OSD_PLAYWRIGHT_PATH,
    );
    const source = (name) =>
      import(
        pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href
      );
    const { AuthStore } = await source("auth-store");
    const { PlatformServer } = await source("platform-server");
    const { CliRuntimeManager } = await source("cli-runtime");
    const { CollaborationStore } = await source("collaboration");
    const root = await mkdtemp(join(tmpdir(), "scikeel-collaboration-web-"));
    await mkdir(join(root, "workers"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const authStore = new AuthStore({
      filePath: join(root, "auth.json"),
      bootstrapAdmin: { username: "fixture", password: "fixture-password" },
    });
    // A fixed, isolated OpenCode HTTP fixture. Real tool suspension is covered by the pinned-runtime acceptance.
    const token = "a".repeat(64),
      session = {
        id: "owned",
        title: "Research fixture",
        directory: workspace,
        parentID: null,
        time: { created: Date.now(), updated: Date.now() },
      };
    const streams = new Set();
    const runtime = createServer(async (req, res) => {
      const path = new URL(req.url, "http://fixture.invalid").pathname;
      if (path === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        );
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      let body =
        path === "/session/owned"
          ? session
          : (path === "/session" || path === "/experimental/session")
            ? [session]
            : path === "/session/status"
              ? {}
              : path === "/config"
                ? { model: "fixture/model" }
                : path === "/config/providers"
                  ? {
                      providers: [
                        {
                          id: "fixture",
                          name: "Fixture",
                          models: {
                            model: { id: "model", name: "Fixture model" },
                          },
                        },
                      ],
                      default: { fixture: "model" },
                    }
                  : path === "/provider"
                    ? { all: [], connected: ["fixture"] }
                    : path === "/agent"
                      ? [{ name: "build", mode: "primary" }]
                      : path === "/v1/whoami"
                        ? { directory: workspace, mode: "full" }
                        : [];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise((r) => runtime.listen(0, "127.0.0.1", r));
    let userId;
    const worker = {
      id: "fixture",
      userId: null,
      generation: 1,
      status: "running",
      workspaceDir: workspace,
    };
    const manager = {
      rootDir: join(root, "workers"),
      init: async () => {},
      ensureWorker: async () => worker,
      getWorker: () => ({ ...worker, id: `user-${userId}`, userId }),
      getWorkerAccess: () => ({
        url: `http://127.0.0.1:${runtime.address().port}`,
        token,
      }),
      acquireOperation: () => () => {},
      listWorkers: () => [worker],
    };
    const webRoot = process.env.OSD_WEB_CANDIDATE || (
      await readFile(resolve("../../.deploy/attachments-build-path"), "utf8")
    ).trim();
    const platform = new PlatformServer({
      authStore,
      workerManager: manager,
      cliRuntime: new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome: join(root, "codex"), claudeConfigDir: join(root, "claude"),
        assistantAuthority: { inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) } }),
      webRoot,
    });
    const address = await platform.listen();
    const origin = `http://${address.host}:${address.port}`;
    const browser = await chromium.launch({
      executablePath: process.env.OSD_CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [1280, 390, 320])
        for (const chinese of [false, true]) for (const selectedMode of ["collaborative", "guided", "delegated"]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
          });
          try {
            const login = await context.request.post(`${origin}/auth/login`, {
              headers: { accept: "application/json" },
              data: { username: "fixture", password: "fixture-password" },
            });
            expect(login.status()).toBe(200);
            userId = (await login.json()).user.id;
            platform.collaboration = new CollaborationStore({
              rootDir: join(root, `${width}-${chinese}-${selectedMode}`),
              research: platform.researchTasks,
            });
            platform.collaborationCapabilities.set(userId, 1);
            const owner = {
              userId,
              sessionId: "owned",
              runtime: "opencode",
              directory: workspace,
              workspaceDir: workspace,
            };
            await platform.collaboration.heartbeat(owner, "fixture-page");
            const selected = await platform.collaboration.setMode(owner, selectedMode, 0);
            await platform.collaboration.begin(owner, selected.revision);
            await platform.collaboration.checkpoint(owner, {
              kind: selectedMode === "guided" ? "step" : "method",
              question: `Which normalization method should be used? File: ${"x".repeat(300)}`,
              suggestedAnswer: "Use the original measurements",
            });
            await context.addInitScript(
              (locale) => localStorage.setItem("ai4s.locale", locale),
              chinese ? "zh-Hans" : "en",
            );
            const page = await context.newPage();
            const errors = [],
              prompts = [];
            page.on("pageerror", (e) => errors.push(e.message));
            page.on("request", (r) => {
              if (
                r.method() === "POST" &&
                /\/session\/[^/]+\/(prompt_async|message)/.test(r.url())
              )
                prompts.push(r.url());
            });
            await page.goto(`${origin}/live/owned`);
            const card = page.getByRole("region", {
              name: selectedMode === "guided" ? (chinese ? "下一步确认" : "Next research step") : (chinese ? "科研决策确认" : "Research decision"),
            });
            await card.waitFor({ state: "visible",timeout:10000 }).catch(async error=>{await page.screenshot({path:resolve("../../.deploy/collaboration-browser-failure.png"),fullPage:true});throw new Error(`${error.message}; page=${(await page.locator("body").innerText()).slice(-5000)}; errors=${JSON.stringify(errors)}`);});
            expect(
              await card
                .getByText("Use the original measurements", { exact: false })
                .count(),
            ).toBe(1);
            expect(prompts).toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            expect(await page.getByRole("button", { name: chinese ? /^托管程度:/ : /^Autonomy:/ }).count()).toBe(0);
            await page.reload();
            await card.waitFor({ state: "visible" });
            expect(prompts).toEqual([]);
            await card.getByRole("textbox").fill("Use method B");
            await card
              .getByRole("button", {
                name: chinese ? "确认答复" : "Confirm answer",
              })
              .click();
            await expect
              .poll(
                async () =>
                  (await platform.collaboration.get(owner)).decisions.at(-1)
                    ?.answer,
              )
              .toBe("Use method B");
            expect(prompts).toEqual([]);
            if (selectedMode === "guided") {
              // Recovery preserves the existing execution; start again only if it actually settled.
              const current = await platform.collaboration.get(owner);
              if (["paused", "completed"].includes(current.phase)) await platform.collaboration.begin(owner, current.revision);
              await platform.collaboration.checkpoint(owner, { kind: "step", question: "Inspection completed: two missing values. Confirm the next analysis outcome?", suggestedAnswer: "Analyze all observations" });
              await card.getByText("Inspection completed: two missing values. Confirm the next analysis outcome?").waitFor();
              expect((await platform.collaboration.get(owner)).decisions).toHaveLength(1);
              expect((await platform.collaboration.guard(owner)).blocked).toBe(true);
              await card.getByRole("textbox").fill("Run the next analysis");
              await card.getByRole("button", { name: chinese ? "确认答复" : "Confirm answer" }).click();
              await expect.poll(async () => (await platform.collaboration.get(owner)).decisions.length).toBe(2);
              expect(prompts).toEqual([]);
            }
            await mkdir(resolve("../../.deploy/verification"), {
              recursive: true,
            });
            await page.screenshot({
              path: resolve(
                `../../.deploy/verification/collaboration-${selectedMode}-${width}-${chinese ? "zh" : "en"}.png`,
              ),
              fullPage: true,
            });
            expect(errors).toEqual([]);
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
      for (const stream of streams) stream.destroy();
      await platform.close();
      runtime.closeAllConnections();
      await new Promise((r) => runtime.close(r));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);

test.skipIf(!process.env.OSD_COLLABORATION_BROWSER)(
  "Web send recovery preserves files and sends once across desktop and phone widths",
  async () => {
    const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
    const source=name=>import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
    const {AuthStore}=await source("auth-store"),{PlatformServer}=await source("platform-server"),{TenantPolicy}=await source("tenant-policy"),{CliRuntimeManager}=await source("cli-runtime");
    const webRoot=process.env.OSD_WEB_CANDIDATE || (await readFile(resolve("../../.deploy/attachments-build-path"),"utf8")).trim();
    const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
    try {
      for(const width of [1280,390,320])for(const locale of ["en","zh-Hans"]){
        const root=await mkdtemp(join(tmpdir(),"scikeel-send-browser-")),workspace=join(root,"workspace");
        await mkdir(workspace);await mkdir(join(root,"workers"));
        const authStore=new AuthStore({filePath:join(root,"auth.json"),bootstrapAdmin:{username:"fixture",password:"fixture-password"}});
        const policy=new TenantPolicy(),streams=new Set(),history=[],nativePrompts=[];
        let userId,mode="normal",busy=false;
        const session={id:"owned",title:"Send recovery fixture",directory:workspace,time:{created:Date.now(),updated:Date.now()}};
        const catalog={model:"fixture/model",providers:[{id:"fixture",name:"Fixture",models:{model:{id:"model",name:"Fixture model"}}}],connected:["fixture"],defaults:{fixture:"model"}};
        const runtime=createServer(async(req,res)=>{
          const path=new URL(req.url,"http://fixture.invalid").pathname;
          if(path==="/event"){
            res.writeHead(200,{"content-type":"text/event-stream"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);
            streams.add(res);res.on("close",()=>streams.delete(res));return;
          }
          if(path==="/session/owned/prompt_async" && req.method==="POST"){
            const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());nativePrompts.push(body);
            history.push({info:{id:body.messageID,role:"user",sessionID:"owned",time:{created:Date.now()}},parts:body.parts});busy=true;
            if(mode==="lost"){res.destroy();return;}
            res.writeHead(202,{"content-type":"application/json"});res.end("{}");return;
          }
          if(path==="/session/owned" && req.method==="PATCH")for await(const _chunk of req){/* Drain permission updates. */}
          const body=path==="/session/owned"?session:path==="/session/owned/message"?history:
            ["/session","/experimental/session"].includes(path)?[session]:path==="/session/status"?(busy?{owned:{type:"busy"}}:{}):
            path==="/v1/whoami"?{directory:workspace,mode:"full"}:path==="/agent"?[{name:"build",mode:"primary"}]:[];
          res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(body));
        });
        await new Promise(resolve=>runtime.listen(0,"127.0.0.1",resolve));
        const worker={id:"fixture",userId:null,generation:1,status:"running",workspaceDir:workspace};
        const manager={rootDir:join(root,"workers"),init:async()=>{},ensureWorker:async()=>({...worker,id:`user-${userId}`,userId}),
          getWorker:()=>({...worker,id:`user-${userId}`,userId}),getWorkerAccess:()=>({url:`http://127.0.0.1:${runtime.address().port}`,token:"a".repeat(64)}),
          acquireOperation:()=>()=>{},retainWorker:()=>({generation:1,release(){}}),listWorkers:()=>[]};
        const platform=new PlatformServer({authStore,workerManager:manager,tenantPolicy:policy,workspaceFiles:{call:async()=>({})},
          cliRuntime:new CliRuntimeManager({rootDir:join(root,"cli"),codexHome:join(root,"codex"),claudeConfigDir:join(root,"claude"),
            assistantAuthority:{inventory:async()=>({activeExecutions:[],uncertainEffects:[]})}}),
          runtimeCatalog:async()=>catalog,webRoot});
        const address=await platform.listen(),origin=`http://${address.host}:${address.port}`;
        clearInterval(platform.researchTimer);platform.collaboration.cancel=async()=>{};platform.researchTasks.cancel=async()=>{};
        const context=await browser.newContext({viewport:{width,height:900}});
        try {
          const login=await context.request.post(`${origin}/auth/login`,{headers:{accept:"application/json"},data:{username:"fixture",password:"fixture-password"}});
          expect(login.status()).toBe(200);userId=(await login.json()).user.id;
          const owner={userId,instanceId:`user-${userId}`,generation:1,workspaceDir:workspace};
          policy.registerAccount(owner);policy.registerSession(owner,session);await platform.runtimeCollaboration(owner,{action:"capability",sessionId:"capability"});
          await context.addInitScript(value=>localStorage.setItem("ai4s.locale",value),locale);
          const strings=JSON.parse(await readFile(resolve(`src/i18n/locales/${locale}/session.json`),"utf8")).composer;
          const page=await context.newPage(),posts=[],errors=[];
          page.on("request",request=>{if(request.method()==="POST" && /\/session\/owned\/prompt_async/.test(request.url()))posts.push(request.postDataJSON());});
          page.on("pageerror",error=>errors.push(error.message));
          await page.goto(`${origin}/live/owned`);const composer=page.locator("textarea").first();await composer.waitFor();
          await expect.poll(()=>composer.isEnabled()).toBe(true);
          const chooser=page.waitForEvent("filechooser");await page.getByRole("button",{name:strings.attach.addAria,exact:true}).click();
          await (await chooser).setFiles({name:"retained.csv",mimeType:"text/csv",buffer:Buffer.from("value\n2\n")});
          await page.getByText("retained.csv",{exact:true}).first().waitFor();
          await expect.poll(async()=>{const drafts=await platform.attachments.list(userId,"owned");return drafts.attachments.length;}).toBe(1);
          const materialize=platform.attachments.materializeCopies;
          platform.attachments.materializeCopies=async()=>{throw Object.assign(new Error("Workspace access denied."),{statusCode:403,code:"workspace_rpc_denied"});};
          const text=`Retain my text ${width} ${locale}`;await composer.fill(text);
          await expect.poll(()=>page.getByRole("button",{name:strings.send.aria,exact:true}).isEnabled(),{timeout:5000}).toBe(true);
          await page.getByRole("button",{name:strings.send.aria,exact:true}).click();
          const denied=page.getByText(strings.error.workspaceDenied,{exact:false}).first();await denied.waitFor({state:"attached"});await denied.locator("..").locator("summary").click();await denied.waitFor();
          await expect.poll(()=>composer.inputValue()).toBe(text);expect(posts).toHaveLength(1);expect(nativePrompts).toHaveLength(0);
          expect((await platform.attachments.list(userId,"owned")).attachments).toHaveLength(1);
          platform.attachments.materializeCopies=materialize;
          await page.getByRole("button",{name:strings.send.aria,exact:true}).click();
          await expect.poll(()=>nativePrompts.length).toBe(1);await expect.poll(()=>composer.inputValue()).toBe("");expect(posts).toHaveLength(2);
          const stateOwner={...owner,sessionId:"owned",runtime:"opencode",directory:workspace};const state=await platform.collaboration.get(stateOwner);
          const replay=await context.request.post(`${origin}/session/owned/prompt_async`,{headers:{origin,"x-scikeel-runtime-generation":"1","x-scikeel-assistant-revision":"1"},data:{...posts[1],collaborationRevision:state.revision}});
          expect(replay.status()).toBe(202);expect(nativePrompts).toHaveLength(1);
          await platform.collaboration.settled(stateOwner,state.execution);busy=false;
          for(const stream of streams)stream.write(`data: ${JSON.stringify({type:"session.status",properties:{sessionID:"owned",status:{type:"idle"}}})}\n\n`);
          await page.getByRole("button",{name:strings.send.aria,exact:true}).waitFor();mode="lost";
          const uncertain=`Unconfirmed ${width} ${locale}`;await composer.fill(uncertain);
          await page.getByRole("button",{name:strings.send.aria,exact:true}).click();
          const unknown=page.getByText(strings.error.deliveryUnconfirmed,{exact:false}).first();await unknown.waitFor({state:"attached"});await unknown.locator("..").locator("summary").click();await unknown.waitFor();
          await expect.poll(()=>composer.inputValue()).toBe(uncertain);expect(posts).toHaveLength(3);expect(nativePrompts).toHaveLength(2);
          await page.reload();await composer.waitFor();expect(posts).toHaveLength(3);expect(nativePrompts).toHaveLength(2);
          expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
          expect((await platform.attachments.list(userId,"owned")).attachments).toHaveLength(1);
        } finally {
          await context.close();for(const stream of streams)stream.destroy();await platform.close();runtime.closeAllConnections();
          await new Promise(resolve=>runtime.close(resolve));await rm(root,{recursive:true,force:true});
        }
      }
    } finally {await browser.close();}
  },120000,
);
