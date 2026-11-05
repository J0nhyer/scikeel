import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dockerEnv } from "./bootstrap-docker.mjs";

test("writes a complete docker env", () => {
  const env = dockerEnv({ dataDir: "/Users/me/scikeel/.local/data", platformUid: 1000, platformGid: 1000, frontSubnet: "172.30.0.0/24", frontPlatformIp: "172.30.0.10", imageDigest: "sha256:" + "a".repeat(64) });
  assert.equal(env.PLATFORM_DATA_DIR, "/srv/scikeel/data");
  assert.equal(env.SANDBOX_DATA_HOST_DIR, "/Users/me/scikeel/.local/data");
  assert.equal(env.PLATFORM_SANDBOX_BACKEND, "docker");
  assert.equal(env.PLATFORM_SANDBOX_DISABLED_RUNTIMES, "codex");
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
