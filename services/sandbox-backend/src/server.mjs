import { createServer } from "node:net";
import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_FRAME, parseFrame, successFrame, failureFrame } from "./protocol.mjs";

function errorCode(error) {
  return typeof error?.code === "string" && error.code.length > 0 ? error.code : "internal_error";
}

export async function createSandboxServer({ sandbox, socketPath, controlGid = 1000 }) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  let queue = Promise.resolve();
  const dispatch = (frame) => {
    const result = queue.then(async () => {
      try {
        return successFrame(frame.requestId, await sandbox[frame.op](frame.args));
      } catch (error) {
        return failureFrame(frame.requestId, errorCode(error));
      }
    });
    queue = result.catch(() => {});
    return result;
  };

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const reject = (code) => {
      if (settled) return;
      settled = true;
      socket.end(failureFrame("", code));
    };
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) { reject("invalid_frame"); return; }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== buffer.length - 1) { reject("invalid_frame"); return; }
      settled = true;
      let frame;
      try {
        frame = parseFrame(buffer);
      } catch (error) {
        socket.end(failureFrame("", errorCode(error)));
        return;
      }
      dispatch(frame).then((response) => socket.end(response));
    });
    socket.on("end", () => {
      if (!settled) reject("invalid_frame");
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath, 0o660);
  if (process.getuid?.() === 0) await chown(socketPath, 0, controlGid);

  return {
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
