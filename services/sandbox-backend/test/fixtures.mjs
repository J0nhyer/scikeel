import { join } from "node:path";

export function configFor(root) {
  return {
    dataDir: root,
    dataHostDir: root,
    instancesDir: join(root, "instances"),
    instancesHostDir: join(root, "instances"),
    nativeDir: join(root, "native"),
    nativeHostDir: join(root, "native"),
    stateDir: join(root, "state"),
    stateHostDir: join(root, "state"),
    platformContainer: "scikeel-platform",
    backendContainer: "scikeel-sandbox-backend",
    workerPlatform: "linux/amd64",
    runtime: "runc",
    workerUid: 1000,
    workerGid: 1000,
    memoryBytes: 1073741824,
    swapBytes: 1207959552,
    pidsMax: 256,
    nanoCpus: 1000000000,
    healthTimeoutMs: 1000,
    stopTimeoutSeconds: 5,
  };
}
