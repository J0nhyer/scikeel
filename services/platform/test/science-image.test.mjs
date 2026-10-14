import test from "node:test";
import { spawnSync } from "node:child_process";
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
test("production images require the exact authenticated runner and file-helper source identities", () => {
  const production = { ...manifest(), variant: "production" };
  assert.throws(() => validateImageManifest(production), /runner/);
  const runnerFiles = Object.fromEntries(["runner.mjs", "file-rpc.mjs", "cli-jobs.mjs", "project-environment.py", "science-environment.mjs"].map((name) => [`opt/scikeel/tools/${name}`, "a".repeat(64)]));
  assert.doesNotThrow(() => validateImageManifest({ ...production, runnerFiles }));
  const collaborationFiles = { ...runnerFiles, "opt/scikeel/tools/collaboration.mjs": "c".repeat(64) };
  assert.doesNotThrow(() => validateImageManifest({ ...production, runnerFiles: collaborationFiles }));
  assert.throws(() => validateImageManifest({ ...production, runnerFiles: { ...collaborationFiles,
    "opt/scikeel/tools/collaboration.mjs": "unmeasured" } }), /runner/);
  assert.doesNotThrow(() => validateBuildContext(["tools/collaboration.mjs"]));
  assert.doesNotThrow(() => validateBuildContext(["tools/runner.mjs", "tools/file-rpc.mjs", "tools/cli-jobs.mjs", "tools/project-environment.py", "tools/science-environment.mjs"]));
  for (const patch of [{ ...runnerFiles, "opt/scikeel/tools/unknown.mjs": "a".repeat(64) }, { ...runnerFiles, "opt/scikeel/tools/runner.mjs": "" }])
    assert.throws(() => validateImageManifest({ ...production, runnerFiles: patch }), /runner/);
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
 for name in ['usr/bin/git','usr/bin/rg','opt/scikeel/tools/collaboration.mjs']:
  entry=tarfile.TarInfo(name); entry.size=5; archive.addfile(entry,io.BytesIO(b'owned'))`, archive]);
    const result = JSON.parse(execFileSync("python3", [inspect, archive], { encoding: "utf8" }));
    assert.equal(result.toolHashes?.["usr/bin/git"], createHash("sha256").update("owned").digest("hex"));
    assert.equal(result.toolHashes?.["usr/bin/rg"], createHash("sha256").update("owned").digest("hex"));
    assert.equal(result.toolHashes?.["opt/scikeel/tools/collaboration.mjs"], createHash("sha256").update("owned").digest("hex"));
  } finally { await rm(temporary, { recursive: true }); }
});

// osd has a positional version command; unlike Node/uv, --version is a valued flag.
test("image tool measurement uses the actual osd CLI version command", async () => {
  const { toolVersionArguments } = await import("../../../scripts/dev/prepare-science-image.mjs");
  assert.deepEqual(toolVersionArguments("osd"), ["version"]);
  assert.deepEqual(toolVersionArguments("node"), ["--version"]);
  assert.throws(() => toolVersionArguments("shell"));
});

test("rootfs extraction rewrites absolute links and rejects traversal, privileged modes and duplicate roots", () => {
  const program = `
import hashlib,importlib.util,io,os,pathlib,tarfile,tempfile
spec=importlib.util.spec_from_file_location('installer','../../scripts/dev/install-sandbox-image.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary)
 archive=root/'safe.tar.gz'
 with tarfile.open(archive,'w:gz') as tar:
  directory=tarfile.TarInfo('usr/bin');directory.type=tarfile.DIRTYPE;directory.mode=0o755;tar.addfile(directory)
  file=tarfile.TarInfo('usr/bin/tool');file.size=4;file.mode=0o4755;tar.addfile(file,io.BytesIO(b'tool'))
  link=tarfile.TarInfo('bin');link.type=tarfile.SYMTYPE;link.linkname='/usr/bin';tar.addfile(link)
 destination=root/'rootfs';destination.mkdir()
 assert module.digest(archive)==hashlib.sha256(archive.read_bytes()).hexdigest()
 module.extract_checked(archive,destination)
 assert os.readlink(destination/'bin')=='usr/bin'
 assert (destination/'bin/tool').read_bytes()==b'tool'
 assert (destination/'usr/bin/tool').stat().st_mode & 0o6022==0
 for name in ['../escape','/escape','usr/../escape']:
  bad=root/'bad.tar.gz'
  with tarfile.open(bad,'w:gz') as tar:
   file=tarfile.TarInfo(name);file.size=1;tar.addfile(file,io.BytesIO(b'x'))
  out=root/('bad-'+str(len(name)));out.mkdir(exist_ok=True)
  try: module.extract_checked(bad,out)
  except ValueError: pass
  else: raise AssertionError('accepted an escape')
`;
  const result = spawnSync("/usr/bin/python3", ["-c", program], { cwd: new URL("../../../services/platform/", import.meta.url), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});


test("patched title runtime identity is measured against the exact locked binary", async () => {
  const { readFile } = await import("node:fs/promises");
  const lock = JSON.parse(await readFile(new URL("../../../runtime/opencode-patches/session-title.lock.json", import.meta.url)));
  const runtime = { ...lock, target: "bun-linux-x64", version: lock.upstreamVersion, binarySha256: manifest().tools.opencode.sha256 };
  assert.doesNotThrow(() => validateBuildContext(["tools/session-title-runtime.json"]));
  assert.doesNotThrow(() => validateImageManifest({ ...manifest(), sessionTitleRuntime: runtime }));
  for (const patch of [{ patchSha256: "d".repeat(64) }, { binarySha256: "e".repeat(64) }, { upstreamCommit: "f".repeat(40) }, { policy: "off" }]) {
    assert.throws(() => validateImageManifest({ ...manifest(), sessionTitleRuntime: { ...runtime, ...patch } }), /runtime|identity|locked/);
  }
});

test('the outcome parser is an explicitly measured image input and runner resource', async () => {
  const { imageInputPath } = await import('../../../scripts/dev/web-release-policy.mjs');
  assert.equal(imageInputPath('packages/sdk/src/tool-outcome.mjs'), true);
  assert.equal(imageInputPath('packages/sdk/src/unrelated.ts'), false);
  assert.doesNotThrow(() => validateBuildContext(['tools/tool-outcome.mjs']));
});
