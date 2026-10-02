// Acceptance CLI: validates image bytes and reads real uploaded document bytes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const runtime=process.argv[2],args=process.argv.slice(3);
let prompt=args.includes("-p")?args[args.indexOf("-p")+1]:args.at(-1);let content;
if(args.includes("--input-format")) {let input="";for await(const chunk of process.stdin)input+=chunk;content=JSON.parse(input).message.content;prompt=content.filter((c)=>c.type==="text").map((c)=>c.text).join("\n");}
const images=[];
for(let i=0;i<args.length;i++)if(args[i]==="--image")images.push(await readFile(args[i+1]));
if(content) for(const part of content)if(part.type==="image")images.push(Buffer.from(part.source.data,"base64"));
const line=prompt.split("\n").find((value)=>value.startsWith('[{"name":'));
const files=line?JSON.parse(line):[];
const checks=[];
for(const file of files) {
  const raw=await readFile(file.path);
  if(file.name.endsWith(".csv")){const rows=raw.toString().trim().split("\n").slice(1).map(Number);checks.push(`CSV mean: ${rows.reduce((a,b)=>a+b,0)/rows.length}`);}
  if(file.name.endsWith(".pdf")){if(!raw.subarray(0,5).equals(Buffer.from("%PDF-")))throw new Error("Invalid PDF");checks.push("PDF bytes verified");}
  checks.push(`${file.name}: ${createHash("sha256").update(raw).digest("hex")}`);
}
for(const image of images){if(!image.length)throw new Error("Image bytes missing");checks.push(`Image input verified: ${createHash("sha256").update(image).digest("hex")}`);}
const answer=checks.join("\n")||"Text received";
if(runtime==="claude"){
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"attachment-native-session"}));
  console.log(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:answer}]}}));
  console.log(JSON.stringify({type:"result",subtype:"success",session_id:"attachment-native-session",result:answer}));
}else{
  console.log(JSON.stringify({type:"thread.started",thread_id:"attachment-native-session"}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:answer}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:10}}));
}
