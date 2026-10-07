import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { attachmentError, ATTACHMENT_LIMITS } from "./attachments.mjs";
const send = (res,status,value) => { res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(value === undefined ? undefined : JSON.stringify(value)); };
async function body(request) {
  let text="";for await (const chunk of request) {text+=chunk.toString();if(Buffer.byteLength(text)>16384) throw attachmentError("Attachment request too large",413);}
  try{return JSON.parse(text||"{}");}catch{throw attachmentError("Invalid attachment request");}
}
function ownerFrom(value) {
  const owner = { ...(value.draftId ? {draftId:value.draftId}:{}), ...(value.sessionId ? {sessionId:value.sessionId}:{}) };
  if (!!owner.draftId === !!owner.sessionId) throw attachmentError("Choose exactly one attachment owner");return owner;
}
/** Authenticated routes; caller supplies the identity from the platform session. */
export function createAttachmentRouter({store,resolveOwner}) {
  const tickets=new Map(), counts=new Map();let active=0;
  async function authorize(user,owner) { if(owner.sessionId) await resolveOwner(user,owner.sessionId); else await store.draftFiles(user.id,owner.draftId); }
  async function uploadSlot(userId,run) {if(active>=4 || (counts.get(userId)??0)>=2) throw attachmentError("Upload queue is busy. Retry shortly.",429,"upload_busy"); active++;counts.set(userId,(counts.get(userId)??0)+1);try{return await run();}finally{active--;counts.set(userId,counts.get(userId)-1);} }
  return async function route(request,response,user) {
    const url=new URL(request.url,"http://platform.invalid"),path=url.pathname;
    if(!path.startsWith("/api/attachments")) return false;
    try {
      if(request.method!=="GET" && request.headers.origin) {
        const origin=new URL(request.headers.origin); if(origin.host!==request.headers.host) throw attachmentError("Cross-origin attachment mutation is forbidden",403);
      }
      if(path==="/api/attachments/drafts" && request.method==="POST") {send(response,201,await store.createDraft(user.id));return true;}
      if(path==="/api/attachments/claim" && request.method==="POST") {
        const value=await body(request);await authorize(user,{sessionId:value.sessionId});
        send(response,200,await store.claim(user.id,value.draftId,value.sessionId,value.attachmentIds));return true;
      }
      if(path==="/api/attachments" && request.method==="GET") {const owner=ownerFrom(Object.fromEntries(url.searchParams));await authorize(user,owner);if(!owner.sessionId) throw attachmentError("A conversation is required");send(response,200,await store.list(user.id,owner.sessionId));return true;}
      const image=path.match(/^\/api\/attachments\/([^/]+)\/image$/);
      if((path==="/api/attachments/upload" && request.method==="POST") || (image && request.method==="PUT")) {
        const owner=ownerFrom(Object.fromEntries(url.searchParams));await authorize(user,owner);
        const limit=image ? ATTACHMENT_LIMITS.imageBytes:ATTACHMENT_LIMITS.fileBytes;
        if(Number(request.headers["content-length"]??0)>limit) throw attachmentError("Attachment is too large",413,"file_too_large");
        const result=await uploadSlot(user.id,()=>image ? store.putImage(user.id,owner,image[1],request,url.searchParams.get("delivery")) : store.upload(user.id,owner,url.searchParams.get("name"),request));
        send(response,image?200:201,result);return true;
      }
      const ticketMatch=path.match(/^\/api\/attachments\/([^/]+)\/ticket$/);
      if(ticketMatch && request.method==="POST") {
        const value=await body(request),owner=ownerFrom(value);await authorize(user,owner);await store.get(user.id,owner,ticketMatch[1]);
        for(const [key,item] of tickets) if(item.expires<=Date.now()) tickets.delete(key);
        if(tickets.size>=4096) tickets.delete(tickets.keys().next().value);
        const ticket=randomBytes(32).toString("hex");tickets.set(ticket,{userId:user.id,owner,id:ticketMatch[1],preview:value.preview===true,download:value.download===true,expires:Date.now()+60000});send(response,200,{ticket});return true;
      }
      if(path==="/api/attachments/read" && request.method==="GET") {
        const ticket=tickets.get(url.searchParams.get("ticket"));if(!ticket || ticket.userId!==user.id || ticket.expires<=Date.now()) throw attachmentError("Attachment preview expired",404);
        await authorize(user,ticket.owner);const file=await store.get(user.id,ticket.owner,ticket.id);const path=await store.path(user.id,ticket.owner,ticket.id,ticket.preview);
        const stat=await fs.stat(path);const inline=!ticket.download && (/^image\/(png|jpeg|gif|webp)$/.test(file.mime) || file.mime==="application/pdf" || file.mime==="application/json" || file.mime.startsWith("text/"));
        const filename=encodeURIComponent(file.name).replace(/[!'()*]/g,(c)=>`%${c.charCodeAt(0).toString(16)}`);
        response.writeHead(200,{"content-type":ticket.preview && file.imageDelivery!=="original" ? (await store.imageMime(user.id,ticket.owner,ticket.id)) : file.mime,"content-length":stat.size,"cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"sandbox","content-disposition":`${inline ? "inline":"attachment"}; filename*=UTF-8''${filename}`});
        await pipeline(createReadStream(path),response);return true;
      }
      const remove=path.match(/^\/api\/attachments\/([^/]+)$/);
      if(remove && request.method==="DELETE") {const owner=ownerFrom(Object.fromEntries(url.searchParams));await authorize(user,owner);await store.removePending(user.id,owner,remove[1]);send(response,204);return true;}
      send(response,404,{error:"Attachment route not found"});return true;
    } catch(error) {if(!response.headersSent && !response.destroyed) send(response,error.status??503,{error:error.status ? error.message:"Attachment storage is unavailable. Retry shortly.",code:error.code??"attachment_error"});else if(!response.writableEnded) response.destroy();return true;}
  };
}
