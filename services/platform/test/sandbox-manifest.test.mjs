import test from "node:test";
import assert from "node:assert/strict";
import { deriveTenantLayout } from "../src/sandbox-manifest.mjs";

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

test("launcher configuration is explicit, complete and cannot enable an unfinished cutover", async () => {
  const { sandboxConfiguration } = await import("../src/sandbox-manifest.mjs");
  assert.equal(sandboxConfiguration({}, "/srv/platform"), null);
  const values = { PLATFORM_SANDBOX_SOCKET: "/run/scikeel/host.sock",
    PLATFORM_SANDBOX_IMAGE_DIGEST: image.digest, PLATFORM_SANDBOX_IMAGES_DIR: roots.images };
  assert.equal(sandboxConfiguration(values, "/srv/platform").layout.workspaceDir, "/srv/platform/workers/instances/config-validation/workspace");
  for (const key of Object.keys(values)) {
    const missing = { ...values }; delete missing[key];
    assert.throws(() => sandboxConfiguration(missing, "/srv/platform"));
  }
  assert.throws(() => sandboxConfiguration({ ...values, PLATFORM_MANAGED_SANDBOX: "1" }, "/srv/platform"), /cutover/);
});
