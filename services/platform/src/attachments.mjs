import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createWriteStream, promises as fs } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ATTACHMENT_LIMITS = Object.freeze({ files: 10, fileBytes: 25 * 1024 ** 2,
  messageBytes: 100 * 1024 ** 2, imageBytes: 512 * 1024, draftMs: 24 * 60 * 60 * 1000 });
export const attachmentError = (message, status = 400, code = "attachment_error") => Object.assign(new Error(message), { status, code });
export function validateMessageBudget(files) {
  if (!Array.isArray(files) || files.length > ATTACHMENT_LIMITS.files ||
    files.some((f) => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > ATTACHMENT_LIMITS.fileBytes) ||
    files.reduce((n, f) => n + f.size, 0) > ATTACHMENT_LIMITS.messageBytes) throw attachmentError("Attachment limits exceeded (10 files, 25 MiB each, 100 MiB total)", 413, "attachment_limit");
}
export function attachmentName(name) {
  if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 240 || /[\\/\x00-\x1f\x7f]/.test(name) || [".", ".."].includes(name)) throw attachmentError("Invalid attachment name");
  return name;
}
const id = (value) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw attachmentError("Invalid attachment identifier"); return value; };
const publicFile = (f) => Object.fromEntries(["id", "name", "size", "mime", "sha256", "createdAt", "sessionId", "imageDelivery"].filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
function detectMime(head, name) {
  if (head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(head.subarray(0,6).toString())) return "image/gif";
  if (head.subarray(0,4).toString() === "RIFF" && head.subarray(8,12).toString() === "WEBP") return "image/webp";
  if (head.subarray(0,5).toString() === "%PDF-") return "application/pdf";
  if (head.includes(0)) return "application/octet-stream";
  if (/\.(txt|md|csv|tsv|json|yaml|yml|py|r|js|ts|html|xml|log)$/i.test(name)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true }); }
    catch { return "application/octet-stream"; }
    return /\.csv$/i.test(name) ? "text/csv" : /\.json$/i.test(name) ? "application/json" : "text/plain";
  }
  return "application/octet-stream";
}
let lastMessageTime = 0, messageCounter = 0;
function messageId() {
  const now = Date.now(); messageCounter = now === lastMessageTime ? messageCounter + 1 : 1; lastMessageTime = now;
  const time = ((BigInt(now) * 4096n + BigInt(messageCounter)) & ((1n << 48n) - 1n)).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(randomBytes(14), (n) => alphabet[n % alphabet.length]).join("")}`;
}

/** Originals and associations are durable; all public access is owner-scoped. */
export class AttachmentStore {
  constructor({ rootDir, now = Date.now, materializeCopies = null }) { this.rootDir = resolve(rootDir); this.now = now; this.queues = new Map(); this.materializeCopies = materializeCopies; }
  async init() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    if (await fs.realpath(this.rootDir) !== this.rootDir) throw attachmentError("Attachment root must not be a symlink", 403);
    await this.folder(join(this.rootDir, "users")); await this.expire();
  }
  async folder(path) {
    const rel = relative(this.rootDir, path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw attachmentError("Invalid attachment storage boundary", 403);
    let current = this.rootDir;
    for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, segment);
      await fs.mkdir(current, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw attachmentError("Unsafe attachment storage directory", 403);
    }
    return path;
  }
  async locked(userId, fn) {
    id(userId); const previous = this.queues.get(userId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(fn); this.queues.set(userId, work);
    try { return await work; } finally { if (this.queues.get(userId) === work) this.queues.delete(userId); }
  }
  async withUser(userId, fn) {
    return this.locked(userId, async () => {
      const dir = await this.folder(join(this.rootDir, "users", id(userId))); const path = join(dir, "records.json");
      let data;
      try { const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { data = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); } }
      catch (e) { if (e.code !== "ENOENT") throw e; data = { version: 1, drafts: {}, files: {}, sessions: {} }; }
      if (data.version !== 1) throw attachmentError("Unknown attachment schema", 500);
      const result = await fn(data, dir);
      const temp = join(dir, `records-${randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" }); await fs.rename(temp, path);
      return result;
    });
  }
  owner(data, owner) {
    if (!!owner.draftId === !!owner.sessionId) throw attachmentError("Choose exactly one attachment owner");
    if (owner.draftId) { const draft = data.drafts[id(owner.draftId)]; if (!draft) throw attachmentError("Attachment draft not found", 404); return draft; }
    const session = data.sessions[id(owner.sessionId)]; if (session?.deleted) throw attachmentError("Conversation attachments not found", 404);
    return session;
  }
  owned(data, owner, fileId) {
    this.owner(data, owner); const file = data.files[id(fileId)];
    if (!file || file.deleted || (owner.sessionId ? file.sessionId !== owner.sessionId : file.state === "sent" || file.draftId !== owner.draftId)) throw attachmentError("Attachment not found", 404);
    return file;
  }
  async createDraft(userId) { return this.withUser(userId, (data) => { const draft = { id: randomUUID(), updatedAt: this.now() }; data.drafts[draft.id] = draft; return draft; }); }
  async draftFiles(userId, draftId) { return this.withUser(userId, (data) => { this.owner(data, { draftId }); return Object.values(data.files).filter((f) => f.draftId === draftId && !f.sessionId && !f.deleted).map(publicFile); }); }
  async writeStream(readable, path, max, name) {
    let size = 0, head = Buffer.alloc(0); const hash = createHash("sha256");
    const temporary = `${path}-${randomUUID()}.tmp`;
    const measure = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > max) { callback(attachmentError("Attachment is too large", 413, "file_too_large")); return; }
      if (head.length < 8192) head = Buffer.concat([head, chunk.subarray(0, 8192 - head.length)]);
      hash.update(chunk); callback(null, chunk);
    } });
    try { await pipeline(readable, measure, createWriteStream(temporary, { flags: "wx", mode: 0o600 })); await fs.rename(temporary, path); }
    catch (e) { await fs.rm(temporary, { force: true }); throw e; }
    return { size, sha256: hash.digest("hex"), mime: detectMime(head, name) };
  }
  async upload(userId, owner, name, readable) {
    attachmentName(name);
    return this.withUser(userId, async (data, dir) => {
      const parent = this.owner(data, owner); if (parent) parent.updatedAt = this.now();
      const fileId = randomUUID(); const folder = await this.folder(join(dir, "blobs", fileId));
      try {
        const measured = await this.writeStream(readable, join(folder, "original"), ATTACHMENT_LIMITS.fileBytes, name);
        const file = { id: fileId, ...owner, name, ...measured, createdAt: this.now(), updatedAt: this.now(), state: "pending" };
        if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) file.imageDelivery = file.size <= ATTACHMENT_LIMITS.imageBytes && file.mime !== "image/gif" ? "original" : "unavailable";
        data.files[fileId] = file; return publicFile(file);
      } catch (e) { await fs.rm(folder, { recursive: true, force: true }); throw e; }
    });
  }
  async putImage(userId, owner, fileId, readable, delivery = "resized") {
    return this.withUser(userId, async (data, dir) => {
      const file = this.owned(data, owner, fileId); if (file.state === "sent") throw attachmentError("Sent attachment cannot be replaced", 409);
      const folder = await this.folder(join(dir, "blobs", id(fileId)));
      const measured = await this.writeStream(readable, join(folder, "preview"), ATTACHMENT_LIMITS.imageBytes, "image.webp");
      if (!/^image\/(png|jpeg|webp)$/.test(measured.mime)) { await fs.rm(join(folder,"preview"),{force:true}); throw attachmentError("Invalid image delivery", 415); }
      file.previewMime = measured.mime; file.imageDelivery = delivery === "still" ? "still" : "resized"; file.updatedAt = this.now(); return publicFile(file);
    });
  }
  async imageMime(userId, owner, fileId) { return this.withUser(userId, (data) => { const file = this.owned(data,owner,fileId); return file.previewMime ?? file.mime; }); }
  async get(userId, owner, fileId) { return this.withUser(userId, (data) => publicFile(this.owned(data, owner, fileId))); }
  async path(userId, owner, fileId, preview = false) {
    return this.withUser(userId, async (data, dir) => {
      const file = this.owned(data, owner, fileId); const folder = await this.folder(join(dir, "blobs", id(fileId)));
      const path = join(folder, preview && file.previewMime ? "preview" : "original");
      const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw attachmentError("Unsafe attachment file", 403); return path;
    });
  }
  async imagePart(userId, sessionId, fileId) {
    return this.withUser(userId, async (data, dir) => {
      const file = this.owned(data, { sessionId }, fileId); if (!file.mime.startsWith("image/")) return null;
      if (file.imageDelivery === "unavailable") throw attachmentError(`Image preparation failed for ${file.name}. Retry or remove it before sending.`, 415, "image_unavailable");
      const folder = await this.folder(join(dir,"blobs",id(fileId))); const path = join(folder,file.previewMime ? "preview" : "original");
      const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ATTACHMENT_LIMITS.imageBytes) throw attachmentError("Image delivery is unavailable", 415);
      const dataBytes = await fs.readFile(path); const mime = file.previewMime ?? file.mime;
      return { filename: file.name, mime, url: `data:${mime};base64,${dataBytes.toString("base64")}`, path, data: dataBytes.toString("base64") };
    });
  }
  async claim(userId, draftId, sessionId, ids) {
    id(sessionId); if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw attachmentError("Invalid attachment list");
    return this.withUser(userId, (data) => {
      const files = ids.map((key) => { const f = data.files[id(key)]; if (!f || f.deleted || f.draftId !== draftId) throw attachmentError("Attachment not found",404); if (f.sessionId && f.sessionId !== sessionId) throw attachmentError("Attachment belongs to another conversation",409); return f; });
      if (data.sessions[sessionId]?.deleted) throw attachmentError("Conversation deleted",404);
      validateMessageBudget(files); for (const f of files) { f.sessionId = sessionId; f.state = f.state === "sent" ? "sent" : "claimed"; }
      data.sessions[sessionId] ??= { turns: {}, updatedAt: this.now() }; return files.map(publicFile);
    });
  }
  async list(userId, sessionId) {
    return this.withUser(userId, (data) => { this.owner(data, { sessionId }); return { attachments: Object.values(data.files).filter((f) => f.sessionId === sessionId && !f.deleted).map(publicFile), turns: Object.values(data.sessions[sessionId]?.turns ?? {}) }; });
  }
  async removePending(userId, owner, fileId) {
    return this.withUser(userId, async (data, dir) => { const file = this.owned(data, owner, fileId); if (file.state === "sent") throw attachmentError("Sent attachments are retained with their conversation",409); file.deleted = true; await fs.rm(join(dir,"blobs",id(fileId)),{recursive:true,force:true}); });
  }
  async prepareTurn(userId, sessionId, context, prompt) {
    id(sessionId); id(context.turnId); const ids = context.attachmentIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw attachmentError("Invalid attachment list");
    return this.withUser(userId, (data) => {
      this.owner(data, { sessionId }); const files = ids.map((key) => this.owned(data,{sessionId},key)); validateMessageBudget(files);
      data.sessions[sessionId] ??= { turns: {}, updatedAt: this.now() };
      const digest = createHash("sha256").update(JSON.stringify({ prompt, ids })).digest("hex"); const previous = data.sessions[sessionId].turns[context.turnId];
      if (previous && previous.digest !== digest && previous.status === "rejected") {
        // A definite rejection did not accept a message. Selecting a supported
        // model may safely replace that attempt while retaining the originals.
        delete data.sessions[sessionId].turns[context.turnId];
      } else if (previous) { if (previous.digest !== digest) throw attachmentError("This send ID was used for another message",409); const result = { ...previous, replayAccepted: previous.status === "accepted", uncertain: previous.status === "prepared" }; if (previous.status === "rejected") previous.status = "prepared"; return result; }
      const turn = { turnId: context.turnId, messageID: messageId(), attachmentIds: ids, digest, status: "prepared", createdAt: this.now() };
      data.sessions[sessionId].turns[turn.turnId] = turn; return turn;
    });
  }
  async finishTurn(userId, sessionId, turnId, status) {
    return this.withUser(userId, (data) => { const turn = data.sessions[sessionId]?.turns[id(turnId)]; if (!turn) throw attachmentError("Attachment turn not found",404); turn.status = status; if (status === "accepted") for (const key of turn.attachmentIds) data.files[key].state = "sent"; return turn; });
  }
  async materialize(userId, sessionId, ids) {
    return this.withUser(userId, async (data, dir) => {
      this.owner(data,{sessionId}); const selected = ids ?? Object.values(data.files).filter((f) => f.sessionId === sessionId && !f.deleted).map((f) => f.id);
      if(this.materializeCopies) {
        const files=[];
        for(const key of selected){const file=this.owned(data,{sessionId},key);const folder=await this.folder(join(dir,"blobs",id(key)));
          files.push({...publicFile(file),sourcePath:join(folder,"original")});}
        return this.materializeCopies({userId,sessionId,files});
      }
      const workDir = await this.folder(join(dir,"working",id(sessionId))); const result = [];
      for (const key of selected) {
        const file = this.owned(data,{sessionId},key); const folder = await this.folder(join(dir,"blobs",id(key)));
        const path = join(workDir,`${key}-${file.name.replace(/[^\p{L}\p{N}._-]/gu,"_")}`);
        await fs.copyFile(join(folder,"original"),path,constants.COPYFILE_EXCL).catch((e) => { if (e.code !== "EEXIST") throw e; });
        const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw attachmentError("Unsafe attachment working copy",403);
        result.push({ ...publicFile(file), path, workDir });
      }
      return result;
    });
  }
  async cloneSession(userId, sourceId, targetId, messageIds) {
    return this.withUser(userId, async (data, dir) => {
      this.owner(data,{sessionId:sourceId}); id(targetId); const turns = Object.values(data.sessions[sourceId]?.turns ?? {}).filter((t) => !messageIds || messageIds.includes(t.messageID)); const keys = [...new Set(turns.flatMap((t) => t.attachmentIds))]; const mapping = new Map();
      for (const key of keys) { const file = this.owned(data,{sessionId:sourceId},key); const newId = randomUUID(); await this.folder(join(dir,"blobs",newId)); await fs.cp(join(dir,"blobs",key),join(dir,"blobs",newId),{recursive:true}); data.files[newId] = { ...file, id: newId, sessionId: targetId, draftId: undefined }; mapping.set(key,newId); }
      data.sessions[targetId] = { turns: Object.fromEntries(turns.map((t) => [t.turnId,{...t,attachmentIds:t.attachmentIds.map((key) => mapping.get(key))}])), updatedAt: this.now() };
      return { attachments: keys.map((key) => publicFile(data.files[mapping.get(key)])), turns: Object.values(data.sessions[targetId].turns) };
    });
  }
  async deleteSession(userId, sessionId) {
    await this.withUser(userId, (data) => { data.sessions[id(sessionId)] ??= { turns: {} }; data.sessions[sessionId].deleted = true; for (const f of Object.values(data.files)) if (f.sessionId === sessionId) f.deleted = true; });
    await this.cleanupUser(userId);
  }
  async cleanupUser(userId) {
    return this.withUser(userId, async (data, dir) => { for (const f of Object.values(data.files)) if (f.deleted) await fs.rm(join(dir,"blobs",id(f.id)),{recursive:true,force:true}); for (const [key,s] of Object.entries(data.sessions)) if (s.deleted) await fs.rm(join(dir,"working",id(key)),{recursive:true,force:true}); });
  }
  async expire() {
    const users = await fs.readdir(join(this.rootDir,"users")).catch(() => []);
    for (const userId of users) {
      await this.withUser(userId, async (data,dir) => {
        for (const f of Object.values(data.files)) if (f.state !== "sent" && this.now() - f.updatedAt > ATTACHMENT_LIMITS.draftMs) f.deleted = true;
        for (const f of Object.values(data.files)) if (f.deleted) await fs.rm(join(dir,"blobs",id(f.id)),{recursive:true,force:true});
        for (const [key,s] of Object.entries(data.sessions)) if (s.deleted) await fs.rm(join(dir,"working",id(key)),{recursive:true,force:true});
        // This user lock excludes in-flight uploads. Unindexed blobs can only
        // be leftovers from a process crash before the atomic metadata commit.
        const blobRoot = join(dir, "blobs");
        for (const entry of await fs.readdir(blobRoot, { withFileTypes: true }).catch(() => [])) {
          if (!data.files[entry.name] && entry.isDirectory() && !entry.isSymbolicLink()) await fs.rm(join(blobRoot, entry.name), { recursive: true, force: true });
        }
        for (const entry of await fs.readdir(dir)) if (/^records-[A-Za-z0-9-]+\.tmp$/.test(entry)) await fs.rm(join(dir, entry), { force: true });
        for (const [key,draft] of Object.entries(data.drafts)) if (this.now() - draft.updatedAt > ATTACHMENT_LIMITS.draftMs) delete data.drafts[key];
      });
    }
  }
  async close() { await Promise.allSettled(this.queues.values()); }
}
