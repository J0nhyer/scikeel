import test from "node:test";
import assert from "node:assert/strict";
import { classifyGatewayRoute, classifyRuntimeRoute, validateRuntimeInput, scrubRuntimeSecrets } from "../src/runtime-route-policy.mjs";

test("raw routes, ambiguous encodings and unsupported methods are denied", () => {
  for (const path of ["/file/content", "/find/file", "/path", "/pty", "/global/config/auth",
    "/session/%2e%2e", "/session/a%252fb", "/session/a%2fb", "/session/../a", "/session//a"])
    assert.equal(classifyRuntimeRoute("GET", path), null);
  assert.equal(classifyRuntimeRoute("PUT", "/session/a"), null);
  assert.equal(classifyRuntimeRoute("GET", "/session/synthetic-a").operation, "sessionRead");
  assert.equal(classifyRuntimeRoute("POST", "/session/a/shell").approval, "command");
  assert.equal(classifyRuntimeRoute("PATCH", "/global/config"), null);
  assert.equal(classifyRuntimeRoute("GET", "/experimental/session").operation, "sessionList");
});

test("query, body and header directory fields are explicit and cannot conflict", () => {
  const route = classifyRuntimeRoute("POST", "/session/a/prompt_async");
  assert.equal(validateRuntimeInput(route, { query: new URLSearchParams("directory=%2Fowned%2Fa"),
    body: { parts: [{ type: "text", text: "hello" }] }, headers: {} }).directory, "/owned/a");
  for (const input of [
    { query: new URLSearchParams("directory=a&directory=b") },
    { query: new URLSearchParams("path=%2Fetc%2Fpasswd") },
    { headers: { "x-opencode-directory": "/other" } },
    { query: new URLSearchParams("directory=a"), body: { directory: "b", parts: [] } },
    { body: { parts: [{ type: "file", url: "file:///etc/passwd" }] } },
    { body: { parts: [{ type: "file", url: "https://peer/secret" }] } },
    { body: { parts: [{ type: "text", text: "x", extra: { directory: "/peer" } }] } },
    { body: { parts: [], userId: "b" } },
  ]) assert.throws(() => validateRuntimeInput(route, input), { statusCode: 400 });
});

test("runtime output scrubbing removes credential values without corrupting usage counts", () => {
  const value = { apiKey: "canary", nested: { authorization: "canary", tokens: 42,
    access_token: "canary", title: "owned" }, model: "science" };
  assert.deepEqual(scrubRuntimeSecrets(value), { nested: { tokens: 42, title: "owned" }, model: "science" });
});

test("current SDK move-session and text-part persistence contracts remain supported", () => {
  const move = classifyRuntimeRoute("POST", "/experimental/control-plane/move-session");
  assert.equal(validateRuntimeInput(move, { body: { sessionID: "ses_a",
    destination: { directory: "/owned/a/project" }, moveChanges: false } }).directory, "/owned/a/project");
  assert.throws(() => validateRuntimeInput(move, { body: { sessionID: "ses_a",
    destination: { directory: "/owned/a", userId: "b" }, moveChanges: false } }), { statusCode: 400 });
  const part = classifyRuntimeRoute("PATCH", "/session/ses_a/message/msg_a/part/prt_a");
  assert.equal(part.operation, "sessionTextPart");
  assert.equal(validateRuntimeInput(part, { body: { id: "prt_a", sessionID: "ses_a", messageID: "msg_a",
    type: "text", text: "owned", synthetic: true, metadata: { scikeel: { generated: true } } } }).body.text, "owned");
  assert.throws(() => validateRuntimeInput(part, { body: { id: "prt_b", sessionID: "ses_a",
    messageID: "msg_a", type: "text", text: "owned" } }), { statusCode: 400 });
});

test("the managed v1 surface cannot bypass runtime session authority", async () => {
  const { classifyGatewayRoute } = await import("../src/runtime-route-policy.mjs");
  for (const path of ["/v1/sessions", "/v1/sessions/foreign/prompt", "/v1/events", "/v1/permissions", "/v1/zen-models"])
    assert.equal(classifyGatewayRoute("GET", path), null);
  assert.equal(classifyGatewayRoute("GET", "/v1/fs/read").operation, "fileRead");
  assert.equal(classifyGatewayRoute("GET", "/v1/runs/query").operation, "runsQuery");
});
test("Web project mutations have fixed methods and identifiers without arbitrary filesystem paths",()=>{
  assert.equal(classifyGatewayRoute("POST","/v1/projects").operation,"projectCreate");
  assert.equal(classifyGatewayRoute("PATCH","/v1/projects/abcdef0123456789").operation,"projectRename");
  assert.equal(classifyGatewayRoute("POST","/v1/projects/abcdef0123456789/pin").operation,"projectPin");
  assert.equal(classifyGatewayRoute("DELETE","/v1/projects/abcdef0123456789").operation,"projectRemove");
  for(const path of ["/v1/projects/../peer","/v1/projects/abcdef0123456789/delete-files","/v1/projects/%2fetc"])
    assert.equal(classifyGatewayRoute("DELETE",path),null);
});
