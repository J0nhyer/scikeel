import test from "node:test";
import assert from "node:assert/strict";
import { validateImageManifest, validateBuildContext, validateArchiveEntry } from "../../../scripts/dev/stage-sandbox-image.mjs";

// Synthetic hashes only. This fixture is never a staging artifact.
function manifest() {
  const sha = "a".repeat(64);
  return { schema: 1, name: "science-v1", variant: "probe", architecture: "linux/amd64",
    rootfsSha256: sha, imageDigest: `sha256:${sha}`, python: "3.12.12", uv: "0.11.26",
    baselineLockSha256: sha, toolLockSha256: sha, uncompressedBytes: 1000000, fileCount: 100,
    provenance: { repository: "J0nhyer/scikeel", commit: "b".repeat(40), workflow: "sandbox-image.yml" },
    tools: Object.fromEntries(["osd", "opencode", "node", "uv", "python", "git"].map((name) => [name, {
      version: name === "opencode" ? "1.18.32" : name === "uv" ? "0.11.26" : name === "python" ? "3.12.12" : "1.0.0",
      sha256: sha, path: `opt/scikeel/tools/bin/${name}` }])), enabledRuntimes: ["opencode"] };
}

test("floating versions and missing tool identities cannot become a managed image", () => {
  assert.doesNotThrow(() => validateImageManifest(manifest()));
  for (const patch of [{ imageDigest: "science:latest" }, { rootfsSha256: "" },
    { architecture: "linux/s390x" }, { python: "3.12" }, { baselineLockSha256: "" },
    { uncompressedBytes: 5 * 1024 ** 3 }, { fileCount: 100001 },
    { tools: { ...manifest().tools, opencode: { ...manifest().tools.opencode, version: "1.18.18" } } },
    { tools: { ...manifest().tools, git: { version: "1.0.0", sha256: "", path: "usr/bin/git" } } },
    { enabledRuntimes: ["opencode", "codex"] },
  ]) assert.throws(() => validateImageManifest({ ...manifest(), ...patch }), /immutable|invalid|pinned|missing/);
});

test("credential canaries and whole-home/checkout copies are forbidden in the build context", () => {
  assert.doesNotThrow(() => validateBuildContext(["Dockerfile", "pyproject.toml", "uv.lock", "tool-lock.json",
    "tools/bin/osd", "tools/bin/opencode", "tools/probe-entry.mjs", "tools/resources/skills-core/research/SKILL.md"]));
  for (const path of ["tools/auth.json", "tools/.codex/config.toml", "tools/.env", "tools/private.key",
    "tools/.git/config", "home/ubuntu/canary", "../../secret", "tools/credentials.json"])
    assert.throws(() => validateBuildContext([path]), /context/);
});

test("rootfs archive entries reject escape paths, devices, duplicate roots and unsafe links", () => {
  assert.doesNotThrow(() => validateArchiveEntry({ path: "usr/bin/python", type: "symlink", link: "../local/bin/python3.12", size: 0 }));
  assert.doesNotThrow(() => validateArchiveEntry({ path: "usr/local/bin/python3.12", type: "file", size: 100 }));
  for (const entry of [{ path: "../host", type: "file", size: 1 }, { path: "/etc/secret", type: "file", size: 1 },
    { path: "dev/mem", type: "device", size: 0 }, { path: "a/link", type: "symlink", link: "../../host", size: 0 },
    { path: "a", type: "fifo", size: 0 }, { path: "x", type: "hardlink", link: "../host", size: 0 }])
    assert.throws(() => validateArchiveEntry(entry), /archive/);
});

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real compressed archives reject traversal, devices and descendants of symlinks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "scikeel-image-test-"));
  const inspect = fileURLToPath(new URL("../../../scripts/dev/inspect-sandbox-archive.py", import.meta.url));
  const create = `import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
 mode=sys.argv[2]
 if mode=='valid':
  entry=tarfile.TarInfo('usr/bin/tool'); entry.size=5; archive.addfile(entry,io.BytesIO(b'owned'))
 elif mode=='link':
  entry=tarfile.TarInfo('usr/bin'); entry.type=tarfile.SYMTYPE; entry.linkname='../local/bin'; archive.addfile(entry)
  entry=tarfile.TarInfo('usr/bin/evil'); entry.size=1; archive.addfile(entry,io.BytesIO(b'x'))
 elif mode=='device':
  entry=tarfile.TarInfo('dev/mem'); entry.type=tarfile.CHRTYPE; archive.addfile(entry)
 else:
  entry=tarfile.TarInfo('../peer'); entry.size=1; archive.addfile(entry,io.BytesIO(b'x'))`;
  try {
    for (const mode of ["valid", "link", "device", "escape"]) {
      const archive = join(temporary, `${mode}.tar.gz`);
      execFileSync("python3", ["-c", create, archive, mode]);
      if (mode === "valid") {
        const value = JSON.parse(execFileSync("python3", [inspect, archive], { encoding: "utf8" }));
        assert.equal(value.fileCount, 1); assert.equal(value.uncompressedBytes, 5);
      } else assert.throws(() => execFileSync("python3", [inspect, archive], { stdio: "pipe" }));
    }
  } finally { await rm(temporary, { recursive: true }); }
});

test("build context file allowlist is exact and cannot hide files beneath a tool name", () => {
  for (const path of ["tools/bin/osd/extra", "tools/bin/arbitrary-exec", "tools/probe-entry.mjs/extra"])
    assert.throws(() => validateBuildContext([path]), /context/);
});

test("CI source image inputs must resolve to fixed registry digests", async () => {
  const { validateSourceImages } = await import("../../../scripts/dev/prepare-science-image.mjs");
  const sha = "a".repeat(64);
  assert.doesNotThrow(() => validateSourceImages({ python: `python@sha256:${sha}`, uv: `ghcr.io/astral-sh/uv@sha256:${sha}` }));
  for (const sources of [{ python: "python:3.12", uv: `ghcr.io/astral-sh/uv@sha256:${sha}` },
    { python: `evil/python@sha256:${sha}`, uv: `ghcr.io/astral-sh/uv@sha256:${sha}` },
    { python: `python@sha256:${sha}`, uv: "ghcr.io/astral-sh/uv:latest" }])
    assert.throws(() => validateSourceImages(sources), /source image/);
});

test("CI workflow is parseable and preserves dedicated limits and attestation output", async () => {
  const { load } = await import("js-yaml");
  const { readFile } = await import("node:fs/promises");
  const workflow = load(await readFile(new URL("../../../.github/workflows/sandbox-image.yml", import.meta.url), "utf8"));
  assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.jobs["science-probe-image"].timeout_minutes, undefined);
  assert.equal(workflow.jobs["science-probe-image"]["timeout-minutes"], 45);
  const steps = workflow.jobs["science-probe-image"].steps;
  assert.ok(steps.some((step) => step.id === "attest"));
  assert.ok(steps.some((step) => step.run?.includes("MemoryMax=2200M")));
  assert.ok(steps.some((step) => step.run?.includes("memory=2g,memory-swap=2304m")));
  assert.ok(steps.some((step) => step.run?.includes("--network=none --read-only")));
});

test("archive inspection measures tool bytes inside the rootfs rather than trusting manifest hashes", async () => {
  const { createHash } = await import("node:crypto");
  const temporary = await mkdtemp(join(tmpdir(), "scikeel-image-hash-"));
  const archive = join(temporary, "rootfs.tar.gz");
  const inspect = fileURLToPath(new URL("../../../scripts/dev/inspect-sandbox-archive.py", import.meta.url));
  try {
    execFileSync("python3", ["-c", `import io,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as archive:
 entry=tarfile.TarInfo('usr/bin/git'); entry.size=5; archive.addfile(entry,io.BytesIO(b'owned'))`, archive]);
    const result = JSON.parse(execFileSync("python3", [inspect, archive], { encoding: "utf8" }));
    assert.equal(result.toolHashes?.["usr/bin/git"], createHash("sha256").update("owned").digest("hex"));
  } finally { await rm(temporary, { recursive: true }); }
});
