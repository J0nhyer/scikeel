import test from "node:test";
import assert from "node:assert/strict";
import { deriveTenantLayout } from "../src/sandbox-manifest.mjs";
import * as manifests from "../src/sandbox-manifest.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const roots = { instances: "/srv/scikeel/workers/instances", native: "/srv/scikeel/cli-runtime/users", images: "/var/lib/scikeel/images" };
const record = { id: "user-a", userId: "a" };
const image = { digest: `sha256:${"a".repeat(64)}` };

test("mounts preserve account paths but exclude platform session envelopes and credentials", () => {
  const layout = deriveTenantLayout({ roots, record, image });
  const sources = layout.mounts.map((mount) => mount.source);
  assert.equal(layout.workspaceDir, "/srv/scikeel/workers/instances/user-a/workspace");
  assert.equal(layout.imageRoot, `/var/lib/scikeel/images/${"a".repeat(64)}/rootfs`);
  assert.ok(sources.includes(layout.workspaceDir));
  assert.ok(sources.includes("/srv/scikeel/cli-runtime/users/a/home"));
  assert.ok(sources.includes("/srv/scikeel/cli-runtime/users/a/codex-home"));
  assert.ok(!sources.includes("/srv/scikeel/cli-runtime/users/a"));
  assert.ok(!sources.some((path) => /sessions\.json|attachments|auth\.json|\.claude$|\/platform$/.test(path)));
  assert.ok(layout.mounts.every((mount) => mount.source === mount.destination));
  assert.ok(layout.mounts.every((mount) => mount.options.includes("nosuid") && mount.options.includes("nodev")));
});

test("public mounts, path collisions, external image locations and malformed IDs are rejected", () => {
  for (const patch of [{ id: "../b" }, { userId: "/etc" }, { mounts: [{ source: "/etc", destination: "/host" }] },
    { sourcePath: "/root" }, { workspaceDir: "/other" }])
    assert.throws(() => deriveTenantLayout({ roots, record: { ...record, ...patch }, image }));
  assert.throws(() => deriveTenantLayout({ roots, record, image: { ...image, rootfsPath: "/" } }), /unexpected/);
  assert.throws(() => deriveTenantLayout({ roots, record, image: { digest: "science:latest" } }), /immutable/);
  for (const override of [{ native: roots.instances }, { instances: "/" }, { images: "/var/lib/../images" },
    { images: `${roots.instances}/images` }])
    assert.throws(() => deriveTenantLayout({ roots: { ...roots, ...override }, record, image }));
});

test("launcher activation requires an explicit flag and complete fixed configuration", async () => {
  const { sandboxConfiguration } = await import("../src/sandbox-manifest.mjs");
  assert.equal(sandboxConfiguration({}, "/srv/platform"), null);
  const values = { PLATFORM_SANDBOX_SOCKET: "/run/scikeel/host.sock",
    PLATFORM_SANDBOX_IMAGE_DIGEST: image.digest, PLATFORM_SANDBOX_IMAGES_DIR: roots.images };
  assert.equal(sandboxConfiguration(values, "/srv/platform").layout.workspaceDir, "/srv/platform/workers/instances/config-validation/workspace");
  for (const key of Object.keys(values)) {
    const missing = { ...values }; delete missing[key];
    assert.throws(() => sandboxConfiguration(missing, "/srv/platform"));
  }
  assert.equal(sandboxConfiguration({ ...values, PLATFORM_MANAGED_SANDBOX: "1" }, "/srv/platform").enabled, true);
  for (const value of ["true", "yes", "unexpected"]) assert.throws(() => sandboxConfiguration({ ...values, PLATFORM_MANAGED_SANDBOX: value }, "/srv/platform"));
  assert.throws(() => sandboxConfiguration({ PLATFORM_MANAGED_SANDBOX: "1" }, "/srv/platform"));
  const separated = sandboxConfiguration({ ...values, PLATFORM_MANAGED_SANDBOX: "1",
    PLATFORM_SANDBOX_INSTANCES_DIR: "/var/lib/scikeel/tenant-data/instances",
    PLATFORM_SANDBOX_NATIVE_DIR: "/var/lib/scikeel/tenant-data/native" }, "/srv/platform");
  assert.equal(separated.roots.instances, "/var/lib/scikeel/tenant-data/instances");
  assert.equal(separated.layout.workspaceDir, "/var/lib/scikeel/tenant-data/instances/config-validation/workspace");
  assert.throws(() => sandboxConfiguration({ ...values, PLATFORM_SANDBOX_INSTANCES_DIR: "/other/instances" }, "/srv/platform"));
});

async function installedImage(t, { codex = false } = {}) {
  await mkdir(join(homedir(), ".cache"), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(homedir(), ".cache", "scikeel-image-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imageDirectory = join(directory, "images", "a".repeat(64));
  await mkdir(join(imageDirectory, "rootfs"), { recursive: true, mode: 0o755 });
  const sha = "a".repeat(64), commit = "b".repeat(40);
  const manifest = { schema: 1, name: "science-v1", variant: "production", architecture: "linux/amd64",
    rootfsSha256: sha, imageDigest: image.digest, python: "3.12.12", uv: "0.11.26",
    baselineLockSha256: sha, toolLockSha256: sha, uncompressedBytes: 1000000, fileCount: 100,
    provenance: { repository: "J0nhyer/scikeel", commit, workflow: "sandbox-image.yml" },
    runnerFiles: Object.fromEntries(["runner.mjs", "file-rpc.mjs", "cli-jobs.mjs", "project-environment.py", "science-environment.mjs"]
      .map(name => [`opt/scikeel/tools/${name}`, sha])),
    tools: Object.fromEntries(["osd", "opencode", "node", "uv", "python", "git", ...(codex ? ["codex"] : [])].map(name => [name, {
      version: name === "opencode" ? "1.18.32" : name === "uv" ? "0.11.26" : name === "python" ? "3.12.12" : name === "codex" ? "0.157.1" : "1.0.0",
      sha256: sha, path: `opt/scikeel/tools/bin/${name}` }])), enabledRuntimes: codex ? ["opencode", "codex"] : ["opencode"] };
  if (codex) {
    const paths = ["runtime/codex-patches/required-effect-guard.patch", "runtime/codex-patches/required-effect-guard-tests.patch",
      "runtime/codex-patches/required-effect-guard.lock.json", "scripts/dev/build-codex-guard-runtime.mjs",
      "scripts/dev/probe-production-runner.mjs", "services/platform/fixtures/native-protocol.mjs",
      "runtime/sandbox/native-tools.mjs", "runtime/sandbox/required-effect-guard.mjs", "runtime/sandbox/codex-requirements.toml",
      "runtime/sandbox/native-network.mjs", "runtime/sandbox/native-network.py", "runtime/codex-patches/loopback-address.patch"];
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const lock = JSON.parse(await readFile(new URL("../../../runtime/codex-patches/required-effect-guard.lock.json", import.meta.url), "utf8"));
    manifest.sourceInputs = await Promise.all(paths.map(async path => ({ path, sha256: hash(await readFile(new URL(`../../../${path}`, import.meta.url))) })));
    const integration = { ...lock, source: commit, target: "x86_64-unknown-linux-gnu", binarySha256: sha, version: "codex-cli 0.157.1" };
    manifest.codexRuntime = { integration, resources: { "opt/scikeel/tools/bin/codex-resources/bwrap": lock.bwrapSha256,
      "opt/scikeel/tools/bin/native-integration.json": hash(JSON.stringify(integration)) } };
    for (const [resource, source] of Object.entries({
      "opt/scikeel/tools/native-tools.mjs": "runtime/sandbox/native-tools.mjs",
      "opt/scikeel/runtime/required-effect-guard.mjs": "runtime/sandbox/required-effect-guard.mjs",
      "opt/scikeel/tools/codex-requirements.toml": "runtime/sandbox/codex-requirements.toml",
      "etc/codex/requirements.toml": "runtime/sandbox/codex-requirements.toml",
      "opt/scikeel/tools/native-network.mjs": "runtime/sandbox/native-network.mjs",
      "opt/scikeel/tools/native-network.py": "runtime/sandbox/native-network.py",
    })) manifest.codexRuntime.resources[resource] = manifest.sourceInputs.find(input => input.path === source).sha256;
  }
  const manifestPath = join(imageDirectory, "image-manifest.json"), readyPath = join(imageDirectory, "ready.json");
  const save = () => writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o644 });
  await save(); await writeFile(readyPath, JSON.stringify({ schema: 1, imageDigest: image.digest }), { mode: 0o644 });
  const configuration = manifests.sandboxConfiguration({ PLATFORM_MANAGED_SANDBOX: "1", PLATFORM_SANDBOX_SOCKET: "/run/scikeel/host.sock",
    PLATFORM_SANDBOX_IMAGE_DIGEST: image.digest, PLATFORM_SANDBOX_IMAGES_DIR: join(directory, "images") }, "/srv/platform");
  const load = (config = configuration, options = { ownerUid: process.getuid() }) => manifests.loadSandboxImageConfiguration(config, options);
  return { directory, imageDirectory, manifest, manifestPath, readyPath, configuration, save, load };
}

test("installed capabilities come only from a protected sealed production manifest", async t => {
  assert.equal(typeof manifests.loadSandboxImageConfiguration, "function");
  const fixture = await installedImage(t);
  const value = await fixture.load({ ...fixture.configuration, enabledRuntimes: ["codex"], imageCapabilities: { forged: true } });
  assert.deepEqual(value.enabledRuntimes, ["opencode"]);
  assert.equal(value.imageCapabilities.imageDigest, image.digest);
  assert.equal(value.imageCapabilities.sourceCommit, fixture.manifest.provenance.commit);
  assert.equal(value.imageCapabilities.nativeIntegration, null);
  assert.equal(value.imageCapabilities.forged, undefined);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.enabledRuntimes));
  assert.throws(() => value.enabledRuntimes.push("codex"));
  if (process.getuid() !== 0) await assert.rejects(fixture.load(undefined, {}), /image/);
});

test("a sealed native manifest preserves the measured guard identity without advertising workflow success", async t => {
  const fixture = await installedImage(t, { codex: true });
  const value = await fixture.load();
  assert.deepEqual(value.enabledRuntimes, ["opencode", "codex"]);
  assert.deepEqual(value.imageCapabilities.nativeIntegration, fixture.manifest.codexRuntime.integration);
  assert.ok(Object.isFrozen(value.imageCapabilities.nativeIntegration));
  assert.equal(value.imageCapabilities.activationEligible, undefined);
  fixture.manifest.codexRuntime.integration.patchSha256 = "f".repeat(64); await fixture.save();
  await assert.rejects(fixture.load(), /image|native|guard/i);
});

test("sealed native readiness rejects missing or altered execution resources and source inputs", async t => {
  for (const change of ["missing-resource", "altered-resource", "missing-source", "altered-source", "missing-bwrap-source", "altered-bwrap-source"]) {
    await t.test(change, async t => {
      const fixture = await installedImage(t, { codex: true });
      const resource = "opt/scikeel/runtime/required-effect-guard.mjs";
      const sourcePath = change.includes("bwrap") ? "runtime/codex-patches/loopback-address.patch" : "runtime/sandbox/required-effect-guard.mjs";
      const source = fixture.manifest.sourceInputs.find(input => input.path === sourcePath);
      if (change === "missing-resource") delete fixture.manifest.codexRuntime.resources[resource];
      if (change === "altered-resource") fixture.manifest.codexRuntime.resources[resource] = "f".repeat(64);
      if (change === "missing-source" || change === "missing-bwrap-source") fixture.manifest.sourceInputs = fixture.manifest.sourceInputs.filter(input => input !== source);
      if (change === "altered-source" || change === "altered-bwrap-source") source.sha256 = "f".repeat(64);
      await fixture.save();
      await assert.rejects(fixture.load(), /image|native|guard/i);
    });
  }
});

test("runtime loading rejects altered, unsealed, untrusted and probe manifests before readiness", async t => {
  for (const change of ["digest", "seal", "probe", "runtime", "writable-file", "writable-directory", "missing-rootfs", "oversized", "owner"]) {
    await t.test(change, async t => {
      const fixture = await installedImage(t);
      if (change === "digest") { fixture.manifest.imageDigest = `sha256:${"b".repeat(64)}`; await fixture.save(); }
      if (change === "seal") await writeFile(fixture.readyPath, JSON.stringify({ schema: 1, imageDigest: `sha256:${"b".repeat(64)}` }));
      if (change === "probe") { fixture.manifest.variant = "probe"; await fixture.save(); }
      if (change === "runtime") { fixture.manifest.enabledRuntimes.push("codex"); await fixture.save(); }
      if (change === "writable-file") await chmod(fixture.manifestPath, 0o666);
      if (change === "writable-directory") await chmod(fixture.imageDirectory, 0o777);
      if (change === "missing-rootfs") await rm(join(fixture.imageDirectory, "rootfs"), { recursive: true });
      if (change === "oversized") await writeFile(fixture.manifestPath, " ".repeat(65537));
      await assert.rejects(change === "owner" ? fixture.load(undefined, { ownerUid: process.getuid() + 1 }) : fixture.load(), /image|manifest|seal|owner|native|guard/i);
    });
  }
});

test("readiness never follows linked image directories, manifests, seals or root filesystems", async t => {
  for (const target of ["image-manifest.json", "ready.json", "rootfs", "image-directory", "hardlink"]) {
    await t.test(target, async t => {
      const fixture = await installedImage(t);
      if (target === "image-directory") {
        const alias = join(fixture.directory, "linked-images"); await symlink(join(fixture.directory, "images"), alias);
        await assert.rejects(fixture.load({ ...fixture.configuration, roots: { ...fixture.configuration.roots, images: alias } }), /image|link/i);
        return;
      }
      if (target === "hardlink") await link(fixture.manifestPath, join(fixture.imageDirectory, "extra.json"));
      else {
        const path = join(fixture.imageDirectory, target), destination = join(fixture.directory, "replacement");
        if (target === "rootfs") { await rm(path, { recursive: true }); await mkdir(destination); }
        else { const bytes = await readFile(path); await rm(path); await writeFile(destination, bytes); }
        await symlink(destination, path);
      }
      await assert.rejects(fixture.load(), /image|link|manifest|seal/i);
    });
  }
});

test("disabled configuration cannot carry injected native capabilities", async () => {
  assert.equal(await manifests.loadSandboxImageConfiguration(null), null);
  const value = await manifests.loadSandboxImageConfiguration({ enabled: false, enabledRuntimes: ["codex"], imageCapabilities: { forged: true } });
  assert.deepEqual(value.enabledRuntimes, []); assert.equal(value.imageCapabilities, null);
});
