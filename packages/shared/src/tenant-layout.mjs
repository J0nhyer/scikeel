import { posix } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function invalid(name) {
  return new Error(name);
}

function root(value, name) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.includes("\0") ||
      value.includes("\\") || posix.normalize(value) !== value || value.endsWith("/")) throw invalid(name);
  return value;
}

function identifier(value, name) {
  if (typeof value !== "string" || !ID.test(value)) throw invalid(name);
  return value;
}

export function tenantLayout({ instancesDir, nativeDir, instanceId, userId }) {
  const instances = root(instancesDir, "invalid_instances_root");
  const native = root(nativeDir, "invalid_native_root");
  const instance = identifier(instanceId, "invalid_instance");
  const user = identifier(userId, "invalid_user");
  if (instances === native || instances.startsWith(`${native}/`) || native.startsWith(`${instances}/`)) {
    throw invalid("overlapping_roots");
  }
  const instanceRoot = posix.join(instances, instance);
  const nativeRoot = posix.join(native, user);
  return Object.freeze({
    instanceRoot,
    workspaceDir: posix.join(instanceRoot, "workspace"),
    stateDir: posix.join(instanceRoot, "state"),
    scratchDir: posix.join(instanceRoot, "scratch"),
    home: posix.join(nativeRoot, "home"),
    claudeConfig: posix.join(nativeRoot, "claude-config"),
    codexHome: posix.join(nativeRoot, "codex-home"),
  });
}
