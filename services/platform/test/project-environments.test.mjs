import test from "node:test";
import assert from "node:assert/strict";
import { selectPythonEnvironment } from "../src/project-environments.mjs";

const base = { owned: true, imageDigest: `sha256:${"a".repeat(64)}`, basePython: "/opt/scikeel/science/bin/python", projectDir: "/tenant/project" };
test("projects use the common science baseline until a valid private environment exists", () => {
  assert.deepEqual(selectPythonEnvironment({ ...base, venvState: "absent" }), { kind: "base", python: base.basePython, imageDigest: base.imageDigest });
  assert.equal(selectPythonEnvironment({ ...base, venvState: "valid", venvPython: "/tenant/project/.venv/bin/python" }).kind, "private");
  for (const patch of [{ owned: false, venvState: "absent" }, { venvState: "broken" }, { venvState: "external" },
    { venvState: "valid", venvPython: "/peer/.venv/bin/python" }, { venvState: "valid", venvPython: "/tenant/project/../peer/python" },
    { venvState: "absent", basePython: "/usr/bin/python" }, { venvState: "absent", imageDigest: "latest" }])
    assert.throws(() => selectPythonEnvironment({ ...base, ...patch }));
});
