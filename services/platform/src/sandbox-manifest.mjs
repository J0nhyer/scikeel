import { posix } from "node:path";

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

// Validate rollout configuration now; Task 12 replaces the explicit activation block.
export function sandboxConfiguration(environment, dataDir) {
  if (environment.PLATFORM_MANAGED_SANDBOX && environment.PLATFORM_MANAGED_SANDBOX !== "0")
    throw new Error("managed sandbox cutover is not installed");
  const names = ["PLATFORM_SANDBOX_SOCKET", "PLATFORM_SANDBOX_IMAGE_DIGEST", "PLATFORM_SANDBOX_IMAGES_DIR"];
  if (!names.some((name) => environment[name])) return null;
  if (names.some((name) => !environment[name])) throw new Error("incomplete sandbox configuration");
  const layout = deriveTenantLayout({ roots: { instances: posix.join(root(dataDir), "workers/instances"),
    native: posix.join(dataDir, "cli-runtime/users"), images: environment.PLATFORM_SANDBOX_IMAGES_DIR },
    record: { id: "config-validation", userId: "config-validation" }, image: { digest: environment.PLATFORM_SANDBOX_IMAGE_DIGEST } });
  return Object.freeze({ socketPath: root(environment.PLATFORM_SANDBOX_SOCKET), imageDigest: layout.imageDigest, layout });
}
