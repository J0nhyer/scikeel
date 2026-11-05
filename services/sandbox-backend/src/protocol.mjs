export const MAX_FRAME = 65536;

const MAX_SAFE_GENERATION = 9_007_199_254_740_991;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATIONS = {
  register: ["instanceId", "userId"],
  start: ["instanceId", "generation", "imageDigest"],
  stop: ["instanceId", "generation", "reason"],
  inspect: ["instanceId"],
  inventory: [],
};

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function identifier(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9]/.test(value) && /^[A-Za-z0-9_-]+$/.test(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_frame");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail("invalid_frame");
}

function nonNegativeGeneration(value, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_GENERATION) fail(code);
}

export function parseFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_FRAME) fail("invalid_frame");
  if (bytes[bytes.length - 1] !== 0x0a || bytes.subarray(0, bytes.length - 1).includes(0x0a)) fail("invalid_frame");
  let frame;
  try {
    frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("invalid_frame");
  }
  exactKeys(frame, ["schema", "requestId", "op", "args"]);
  if (frame.schema !== 1 || !identifier(frame.requestId, 128)) fail("invalid_frame");
  if (typeof frame.op !== "string" || !Object.hasOwn(OPERATIONS, frame.op)) fail("invalid_operation");
  exactKeys(frame.args, OPERATIONS[frame.op]);
  const args = frame.args;
  switch (frame.op) {
    case "register":
      if (!identifier(args.instanceId, 64)) fail("invalid_instance");
      if (!identifier(args.userId, 64)) fail("invalid_user");
      break;
    case "start":
      if (!identifier(args.instanceId, 64)) fail("invalid_instance");
      nonNegativeGeneration(args.generation, "invalid_start");
      if (typeof args.imageDigest !== "string" || !DIGEST.test(args.imageDigest)) fail("invalid_start");
      break;
    case "stop":
      if (!identifier(args.instanceId, 64)) fail("invalid_instance");
      nonNegativeGeneration(args.generation, "invalid_stop");
      if (!identifier(args.reason, 64)) fail("invalid_stop");
      break;
    case "inspect":
      if (!identifier(args.instanceId, 64)) fail("invalid_instance");
      break;
  }
  return { requestId: frame.requestId, op: frame.op, args: { ...args } };
}

export function successFrame(requestId, result) {
  return JSON.stringify({ schema: 1, requestId, ok: true, result }) + "\n";
}

export function failureFrame(requestId, code) {
  return JSON.stringify({ schema: 1, requestId, ok: false, error: code }) + "\n";
}
