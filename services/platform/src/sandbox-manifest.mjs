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
