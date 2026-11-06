import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dockerEnv, patchedWorkerJobs } from "./bootstrap-docker.mjs";

test("writes a complete docker env", () => {
  const env = dockerEnv({ dataDir: "/Users/me/scikeel/.local/data", platformUid: 1000, platformGid: 1000, frontSubnet: "172.30.0.0/24", frontPlatformIp: "172.30.0.10", imageDigest: "sha256:" + "a".repeat(64) });
  assert.equal(env.PLATFORM_DATA_DIR, "/srv/scikeel/data");
  assert.equal(env.SANDBOX_DATA_HOST_DIR, "/Users/me/scikeel/.local/data");
  assert.equal(env.PLATFORM_SANDBOX_BACKEND, "docker");
  assert.equal(env.PLATFORM_SANDBOX_DISABLED_RUNTIMES, "codex");
  assert.equal(env.SANDBOX_WORKER_CPUS, "4");
  assert.equal(env.SANDBOX_WORKER_MEMORY, "3221225472");
  assert.equal(env.SANDBOX_WORKER_SWAP, "4294967296");
});

test("local worker override raises the single-thread BLAS defaults", () => {
  const source = 'OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1", PATH: "unchanged"';
  const patched = patchedWorkerJobs(source);
  for (const key of ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"])
    assert.match(patched, new RegExp(`${key}: "4"`));
  assert.match(patched, /PATH: "unchanged"/);
});
test("an existing catalog switches bootstrap to serve mode", () => {
  const env = dockerEnv({ dataDir: "/Users/me/scikeel/.local/data", platformUid: 1000, platformGid: 1000,
    frontSubnet: "172.30.0.0/24", frontPlatformIp: "172.30.0.10", imageDigest: "sha256:" + "a".repeat(64), catalogMigrate: "0" });
  assert.equal(env.PLATFORM_CATALOG_MIGRATE, "0");
});

test("compose forwards the sandbox disabled-runtime policy", async () => {
  const compose = await readFile(new URL("../../compose.yml", import.meta.url), "utf8");
  assert.match(compose, /PLATFORM_SANDBOX_DISABLED_RUNTIMES:/);
  assert.doesNotMatch(compose, /PLATFORM_DISABLED_RUNTIMES:/);
});
