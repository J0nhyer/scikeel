import { posix } from "node:path";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new Error("unexpected tenant layout fields");
}
function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("invalid tenant ID");
  return value;
}
function root(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.includes("\0") ||
      value.includes("\\") || posix.normalize(value) !== value || value.endsWith("/")) throw new Error("invalid configured root");
  return value;
}
export function deriveTenantLayout({ roots, record, image }) {
  exact(roots, ["instances", "native", "images"]);
  exact(record, ["id", "userId"]);
  exact(image, ["digest"]);
  const instanceId = id(record.id); const userId = id(record.userId);
  if (!/^sha256:[a-f0-9]{64}$/.test(image.digest ?? "")) throw new Error("immutable image digest required");
  const values = Object.values(roots).map(root);
  if (values.length !== 3 || values.some((value, index) => values.some((other, second) => index !== second &&
      (value === other || value.startsWith(`${other}/`))))) throw new Error("configured roots overlap");
  const accountRoot = posix.join(roots.instances, instanceId);
  const nativeRoot = posix.join(roots.native, userId);
  const workspaceDir = posix.join(accountRoot, "workspace");
  const stateDir = posix.join(accountRoot, "state");
  const home = posix.join(nativeRoot, "home");
  const scratchDir = posix.join(accountRoot, "scratch");
  const sources = [workspaceDir, stateDir, home, posix.join(nativeRoot, "claude-config"),
    posix.join(nativeRoot, "codex-home"), scratchDir];
  return Object.freeze({ schema: 1, instanceId, userId, imageDigest: image.digest,
    imageRoot: posix.join(roots.images, image.digest.slice(7), "rootfs"), workspaceDir, stateDir, home, scratchDir,
    mounts: sources.map((source) => Object.freeze({ source, destination: source,
      options: Object.freeze(["bind", "rw", "nosuid", "nodev"]) })) });
}

export function sandboxConfiguration(environment, dataDir) {
  const flag = environment.PLATFORM_MANAGED_SANDBOX ?? "0";
  if (!["0", "1"].includes(flag)) throw new Error("managed sandbox flag must be 0 or 1");
  const enabled = flag === "1";
  const names = ["PLATFORM_SANDBOX_SOCKET", "PLATFORM_SANDBOX_IMAGE_DIGEST", "PLATFORM_SANDBOX_IMAGES_DIR"];
  const separated = [environment.PLATFORM_SANDBOX_INSTANCES_DIR, environment.PLATFORM_SANDBOX_NATIVE_DIR];
  if (separated.some(Boolean) && !separated.every(Boolean)) throw new Error("incomplete sandbox tenant roots");
  if (!enabled && !names.some((name) => environment[name])) return null;
  if (names.some((name) => !environment[name])) throw new Error("incomplete sandbox configuration");
  const roots = { instances: environment.PLATFORM_SANDBOX_INSTANCES_DIR ?? posix.join(root(dataDir), "workers/instances"),
    native: environment.PLATFORM_SANDBOX_NATIVE_DIR ?? posix.join(dataDir, "cli-runtime/users"), images: environment.PLATFORM_SANDBOX_IMAGES_DIR };
  const layout = deriveTenantLayout({ roots,
    record: { id: "config-validation", userId: "config-validation" }, image: { digest: environment.PLATFORM_SANDBOX_IMAGE_DIGEST } });
  return Object.freeze({ enabled, socketPath: root(environment.PLATFORM_SANDBOX_SOCKET), imageDigest: layout.imageDigest, roots: Object.freeze(roots), layout });
}

function unchanged(before, after) {
  return ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]);
}

function freezeImage(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeImage(child);
    Object.freeze(value);
  }
  return value;
}

// The privileged installer verifies attestation, archive bytes and tool locks
// before writing ready.json. These protected files are its capability seal;
// loading the seal does not establish live workflow or activation readiness.
export async function loadSandboxImageConfiguration(configuration, { ownerUid = 0 } = {}) {
  if (!configuration) return null;
  if (!configuration.enabled) return Object.freeze({ ...configuration, enabledRuntimes: Object.freeze([]), imageCapabilities: null });
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error("invalid installed image owner");
  const snapshots = new Map();
  const directory = async (path, exactOwner = true) => {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink() || value.mode & 0o022 ||
        (exactOwner ? value.uid !== ownerUid : ![0, ownerUid].includes(value.uid)))
      throw new Error("untrusted installed image directory or owner");
    snapshots.set(path, value);
  };
  const json = async (path, limit) => {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid || before.mode & 0o022 ||
        before.nlink !== 1 || before.size < 1 || before.size > limit) throw new Error("untrusted installed image manifest or seal");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!unchanged(before, await handle.stat())) throw new Error("installed image manifest changed");
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== before.size || bytesRead > limit || !unchanged(before, await handle.stat()) ||
          !unchanged(before, await lstat(path))) throw new Error("installed image manifest changed");
      snapshots.set(path, before);
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  };
  try {
    const images = root(configuration.roots?.images);
    if (!/^sha256:[a-f0-9]{64}$/.test(configuration.imageDigest ?? "")) throw new Error("invalid installed image digest");
    let ancestor = "/";
    await directory(ancestor, false);
    for (const segment of images.slice(1).split("/")) {
      ancestor = posix.join(ancestor, segment);
      await directory(ancestor, ancestor === images);
    }
    const imageDirectory = posix.join(images, configuration.imageDigest.slice(7));
    await directory(imageDirectory); await directory(posix.join(imageDirectory, "rootfs"));
    const manifest = await json(posix.join(imageDirectory, "image-manifest.json"), 65536);
    const seal = await json(posix.join(imageDirectory, "ready.json"), 4096);
    if (!seal || Object.keys(seal).sort().join(",") !== "imageDigest,schema" || seal.schema !== 1 ||
        seal.imageDigest !== configuration.imageDigest || manifest.imageDigest !== configuration.imageDigest ||
        manifest.variant !== "production") throw new Error("installed image seal or production identity mismatch");
    const { validateImageManifest } = await import("../../../scripts/dev/stage-sandbox-image.mjs");
    validateImageManifest(manifest);
    if (new Set(manifest.enabledRuntimes).size !== manifest.enabledRuntimes.length) throw new Error("duplicate installed image runtime");
    for (const [path, snapshot] of snapshots) {
      if (!unchanged(snapshot, await lstat(path))) throw new Error("installed image changed during capability loading");
    }
    return freezeImage({ ...configuration, enabledRuntimes: [...manifest.enabledRuntimes], imageCapabilities: {
      imageDigest: manifest.imageDigest, sourceCommit: manifest.provenance.commit,
      nativeIntegration: manifest.codexRuntime?.integration ?? null,
    } });
  } catch (cause) {
    throw new Error("installed image capability verification failed", { cause });
  }
}
