import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { FileRpc, fileRequest } from "../../../runtime/sandbox/file-rpc.mjs";

test("file RPC allows only bounded owned workspace operations", () => {
  assert.equal(fileRequest({ operation: "read", root: "workspace", path: "papers/a.txt" }).path, "papers/a.txt");
  for (const request of [{ operation: "exec", root: "workspace", path: "a" }, { operation: "read", root: "state", path: "a" },
    { operation: "read", root: "workspace", path: "../peer" }, { operation: "write", root: "workspace", path: "a", text: "a", command: "evil" },
    { operation: "read", root: "workspace", path: "/peer/a" }, { operation: "read", root: "workspace", path: "a", text: "a" }]) assert.throws(() => fileRequest(request));
});
test("helper output is bounded and failures cannot leak internal content", async () => {
  const helper = new FileRpc({ spawnImpl: () => spawn(process.execPath, ["-e", 'process.stderr.write("secret-canary");process.exit(1)'], { detached: true, stdio: ["pipe", "pipe", "pipe"] }) });
  await assert.rejects(helper.call({ operation: "read", root: "workspace", path: "a" }), (error) => !error.message.includes("secret-canary"));
  const flood = new FileRpc({ maxOutputBytes: 100, spawnImpl: () => spawn(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'], { detached: true, stdio: ["pipe", "pipe", "pipe"] }) });
  await assert.rejects(flood.call({ operation: "read", root: "workspace", path: "a" }), /limit/);
});
test("helper cancellation terminates the process group and releases the caller", async () => {
  let child;
  const helper = new FileRpc({ spawnImpl: () => child = spawn(process.execPath, ["-e", 'setInterval(()=>{},1000)'], { detached: true, stdio: ["pipe", "pipe", "pipe"] }) });
  const controller = new AbortController();
  const pending = helper.call({ operation: "read", root: "workspace", path: "a" }, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancel/); assert.ok(child.signalCode);
});
test("binary chunks and private working-copy cleanup have bounded fixed contracts", () => {
  assert.deepEqual(fileRequest({operation:"writeChunk",root:"workspace",path:"attachments/owned",offset:0,bytes:[0,255]}).bytes,[0,255]);
  assert.equal(fileRequest({operation:"readChunk",root:"workspace",path:"attachments/owned",offset:0,limit:256*1024}).limit,256*1024);
  for (const value of [{operation:"writeChunk",offset:0,bytes:[256]}, {operation:"writeChunk",offset:25*1024**2,bytes:[1]},
    {operation:"readChunk",offset:-1,limit:1},{operation:"readChunk",offset:0,limit:256*1024+1},
    {operation:"remove",text:"extra"}])assert.throws(()=>fileRequest({root:"workspace",path:"attachments/owned",...value}));
});
