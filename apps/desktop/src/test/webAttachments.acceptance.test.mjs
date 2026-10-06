// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
const sha=(data)=>createHash("sha256").update(data).digest("hex");
function pdfFixture() {
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const text="BT /F1 12 Tf 10 100 Td (Attachment evidence: keel paper 47) Tj ET";objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  let body="%PDF-1.4\n";const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n)=>`${String(n).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(body);
}
test.skipIf(!process.env.OSD_ATTACHMENTS_ACCEPTANCE)("uploads, restores, downloads and follows up on conversation-owned files over HTTP",async()=>{
  const {chromium}=createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH);
  const module=(name)=>import(pathToFileURL(resolve(`../../services/platform/src/${name}.mjs`)).href);
  const {AuthStore}=await module("auth-store"),{WorkerManager}=await module("worker-manager"),{CliRuntimeManager}=await module("cli-runtime"),{PlatformServer}=await module("platform-server");
  const root=await mkdtemp(join(tmpdir(),"scikeel-attachment-acceptance-"));const home=join(root,"codex");await mkdir(home);await writeFile(join(home,"config.toml"),'model = "fixture-model"\n');
  const authStore=new AuthStore({filePath:join(root,"auth.json"),bootstrapAdmin:{username:"fixture",password:"fixture-password"}});
  const workerManager=new WorkerManager({rootDir:join(root,"workers"),osdCommand:process.execPath,osdArgs:[resolve("../../services/platform/fixtures/fake-osd.mjs")]});
  const cliRuntime=new CliRuntimeManager({rootDir:join(root,"cli"),codexHome:home,claudeConfigDir:join(root,"claude"),codexCommand:process.execPath,codexArgs:[resolve("../../services/platform/fixtures/attachment-cli.mjs"),"codex"]});
  const platform=new PlatformServer({authStore,workerManager,cliRuntime,webRoot:process.env.OSD_ATTACHMENTS_WEB_ROOT || resolve("dist")});const address=await platform.listen();const origin=`http://127.0.0.1:${address.port}`,httpOrigin=`http://scikeel-attachments.test:${address.port}`;
  const browser=await chromium.launch({executablePath:process.env.OSD_CHROMIUM_PATH,args:["--no-sandbox","--disable-dev-shm-usage","--no-proxy-server","--host-resolver-rules=MAP scikeel-attachments.test 127.0.0.1"],headless:true});
  try{
    for(const width of [1280,390]){
      const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});
      try{
        const login=await context.request.post(`${origin}/auth/login`,{headers:{accept:"application/json"},data:{username:"fixture",password:"fixture-password"}});expect(login.status()).toBe(200);const {user}=await login.json();await cliRuntime.setUserRuntime(user.id,"codex");
        const state=await context.storageState();await context.addCookies(state.cookies.map((cookie)=>({...cookie,domain:"scikeel-attachments.test"})));
        await context.addInitScript((locale)=>localStorage.setItem("ai4s.locale",locale),width===390?"zh-Hans":"en");const page=await context.newPage();const errors=[];page.on("pageerror",(e)=>errors.push(e.message));
        await page.goto(`${httpOrigin}/live`);await page.locator("textarea").first().waitFor({state:"visible"});expect(await page.evaluate(()=>isSecureContext)).toBe(false);
        // Exercise clipboard and drop on both desktop and phone widths.
        await page.route("**/api/attachments/upload?**", async (route) => { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture upload interrupted" }) }); }, { times: 1 });
        await page.locator("textarea").first().evaluate((element) => { const transfer = new DataTransfer(); transfer.items.add(new File(["value\n2\n"], "clipboard.csv", { type: "text/csv" })); element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer })); });
        await page.getByRole("button", { name: "Retry clipboard.csv" }).waitFor();
        expect(await page.getByRole("button", { name: width === 390 ? "发送" : "Send", exact: true }).isEnabled()).toBe(false);
        await page.getByRole("button", { name: "Retry clipboard.csv" }).click();
        await expect.poll(async () => page.getByRole("button", { name: width === 390 ? "发送" : "Send", exact: true }).isEnabled()).toBe(true);
        await page.getByRole("button", { name: "Remove clipboard.csv" }).click();
        await page.locator("textarea").first().evaluate((element) => { const transfer = new DataTransfer(); transfer.items.add(new File(["drop content"], "dropped.txt", { type: "text/plain" })); element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })); });
        await page.getByRole("button", { name: "Remove dropped.txt" }).waitFor();
        await expect.poll(async () => page.getByRole("button", { name: width === 390 ? "发送" : "Send", exact: true }).isEnabled()).toBe(true);
        await page.getByRole("button", { name: "Remove dropped.txt" }).click();
        const image=await page.evaluate(()=>{const canvas=document.createElement("canvas");canvas.width=240;canvas.height=180;const ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,240,180);ctx.fillStyle="blue";ctx.beginPath();ctx.moveTo(120,20);ctx.lineTo(20,140);ctx.lineTo(220,140);ctx.fill();ctx.fillStyle="black";ctx.font="18px sans-serif";ctx.fillText("KEEL 47",80,165);return canvas.toDataURL("image/png").split(",")[1];});
        const originals=[{name:"figure.png",mimeType:"image/png",buffer:Buffer.from(image,"base64")},{name:"paper.pdf",mimeType:"application/pdf",buffer:pdfFixture()},{name:"data.csv",mimeType:"text/csv",buffer:Buffer.from("value\n2\n4\n")}];
        await mkdir(resolve("../../.deploy/verification"), { recursive: true });
        await writeFile(resolve("../../.deploy/verification/attachment-figure.png"), originals[0].buffer);
        await writeFile(resolve("../../.deploy/verification/attachment-paper.pdf"), originals[1].buffer);
        await page.locator('input[type="file"]').first().setInputFiles(originals);
        await page.getByRole("button",{name:"Send",exact:true}).or(page.getByRole("button",{name:"发送",exact:true})).waitFor({state:"visible"});
        await expect.poll(async()=>page.getByRole("button",{name:width===390?"发送":"Send",exact:true}).isEnabled()).toBe(true);
        await page.locator("textarea").first().fill("Read the attachments and calculate the CSV mean.");
        await page.route("**/prompt_async*", async (route) => { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture prompt acceptance failed" }) }); }, { times: 2 });
        const rejected = page.waitForResponse((r) => r.request().method() === "POST" && /\/prompt_async/.test(r.url()));
        await page.getByRole("button", { name: width === 390 ? "发送" : "Send", exact: true }).click(); expect((await rejected).status()).toBe(400);
        await expect.poll(async () => page.getByRole("button", { name: width === 390 ? "发送" : "Send", exact: true }).isEnabled(), { timeout: 10000 }).toBe(true);
        expect(await page.locator("textarea").first().inputValue()).toBe("Read the attachments and calculate the CSV mean.");
        for (const original of originals) expect(await page.getByRole("button", { name: `Remove ${original.name}` }).count()).toBe(1);
        const posted=page.waitForResponse((r)=>r.request().method()==="POST" && /\/session\/[^/]+\/prompt_async/.test(r.url()));
        await page.getByRole("button",{name:width===390?"发送":"Send",exact:true}).click();expect((await posted).status()).toBe(202);
        await expect.poll(async()=>page.locator('[data-attachment-id]').count()).toBe(3);
        await expect.poll(async()=>page.locator("body").innerText()).toContain("CSV mean: 3");
        await expect.poll(async()=>page.locator("body").innerText()).toContain("Image input verified:");
        await page.reload();await expect.poll(async()=>page.locator('[data-attachment-id]').count()).toBe(3);
        for(const original of originals){const download=page.waitForEvent("download");await page.getByRole("button",{name:`Download ${original.name}`,exact:true}).click();const result=await download;expect(result.suggestedFilename()).toBe(original.name);expect(sha(await readFile(await result.path()))).toBe(sha(original.buffer));}
        await page.getByRole("button",{name:"Preview figure.png",exact:true}).click();await page.getByRole("dialog").waitFor();await page.getByRole("button",{name:"Close preview"}).click();
        await page.getByRole("button",{name:"Preview paper.pdf",exact:true}).click();await page.getByRole("dialog").locator("canvas").first().waitFor();await page.getByRole("button",{name:"Close preview"}).click();
        await page.locator("textarea").first().fill("Use the earlier CSV again without another upload.");const follow=page.waitForResponse((r)=>r.request().method()==="POST" && /\/prompt_async/.test(r.url()));await page.getByRole("button",{name:width===390?"发送":"Send",exact:true}).click();expect((await follow).status()).toBe(202);
        await expect.poll(async()=>{const state=await cliRuntime.ensureUser(user.id);return [...state.sessions.values()].filter((s)=>s.history.filter((m)=>m.info.role==="user").length>=2 && s.status==="idle").length;}).toBeGreaterThan(0);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
        await mkdir(resolve("../../.deploy/verification"),{recursive:true});await page.screenshot({path:resolve(`../../.deploy/verification/attachments-http-${width}.png`),fullPage:true});
      }finally{await context.close();}
    }
  }finally{await browser.close();await platform.close();await cliRuntime.close();await workerManager.close();await authStore.close();await rm(root,{recursive:true,force:true});}
},120000);
