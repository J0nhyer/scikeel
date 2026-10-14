import test from "node:test";
import assert from "node:assert/strict";
import { buildJobEnvironment, runtimeArgv } from "../../../runtime/sandbox/cli-jobs.mjs";

test("managed jobs never inherit host secrets or shared writable Python paths", () => {
  process.env.SCIKEEL_ADMIN_CANARY = "must-not-leak";
  try {
    const env = buildJobEnvironment({ privateHome: "/tenant/home", projectDir: "/tenant/workspace/project",
      environment: { kind: "base", python: "/opt/scikeel/science/bin/python" }, brokers: {} });
    assert.equal(env.SCIKEEL_ADMIN_CANARY, undefined); assert.equal(env.HOME, "/tenant/home");
    assert.equal(env.UV_PYTHON_DOWNLOADS, "never"); assert.equal(env.UV_LINK_MODE, "copy");
    assert.equal(env.OPENBLAS_NUM_THREADS, "1"); assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.UV_CACHE_DIR, "/tenant/home/.cache/uv");
    const privateEnv = buildJobEnvironment({ privateHome: "/tenant/home", projectDir: "/tenant/workspace/project",
      environment: { kind: "private", python: "/tenant/workspace/project/.venv/bin/python" }, brokers: {} });
    assert.ok(privateEnv.PATH.startsWith("/tenant/workspace/project/.venv/bin:"));
  } finally { delete process.env.SCIKEEL_ADMIN_CANARY; }
});
test("job environment rejects external venvs, arbitrary broker endpoints and injected variables", () => {
  const base = { privateHome: "/tenant/home", projectDir: "/tenant/project", environment: { kind: "base", python: "/opt/scikeel/science/bin/python" }, brokers: {} };
  for (const patch of [{ environment: { kind: "private", python: "/peer/python" } }, { privateHome: "/" },
    { brokers: { modelUrl: "http://169.254.169.254" } }, { brokers: { HTTP_PROXY: "http://peer" } }, { projectDir: "/tenant/../peer" }])
    assert.throws(() => buildJobEnvironment({ ...base, ...patch }));
});
test("runtime argv is fixed and keeps command approval enabled", () => {
  const argv = runtimeArgv({ runtime: "opencode", model: "fixture/approved", sessionId: "native-a" });
  assert.equal(argv[0], "/opt/scikeel/tools/bin/opencode");
  assert.ok(!argv.some((arg) => /dangerously|bypass|yolo/.test(arg)));
  for (const runtime of ["shell", "unknown", "codex", "claude"]) assert.throws(() => runtimeArgv({ runtime, model: "approved" }));
});
