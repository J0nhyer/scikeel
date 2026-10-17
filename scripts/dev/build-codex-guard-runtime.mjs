import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const patches = join(repository, "runtime/codex-patches");
const source = join(repository, ".deploy/codex-source");
const output = join(repository, ".deploy/science-context/tools/bin");
const { parse, stringify } = createRequire(join(repository, "services/platform/package.json"))("smol-toml");
const sha256 = value => createHash("sha256").update(value).digest("hex");

export function validateGuardLock(lock) {
  if (lock?.schema !== 1 || lock.policy !== "required-effect-guard-v1" ||
      lock.upstreamVersion !== "0.157.1" || lock.upstreamCommit !== "36650394c5b38c2990ccf2a3457165ca3e9d9726" ||
      lock.rustVersion !== "1.95.0" || !/^[a-f0-9]{64}$/.test(lock.patchSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(lock.testPatchSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(lock.upstreamLockSha256 ?? "") || !/^[a-f0-9]{64}$/.test(lock.workspaceLockSha256 ?? "") ||
      lock.lockFormat !== "smol-toml@1.9.0" ||
      !/^[a-f0-9]{64}$/.test(lock.bwrapPatchSha256 ?? "") || !/^[a-f0-9]{64}$/.test(lock.bwrapSha256 ?? ""))
    throw new Error("Invalid pinned native guard inputs");
  return lock;
}

export function validateRustRegression(result, phase) {
  const output = result.stdout ?? "";
  const expectedFailures = ["scikeel_required_guard_allow_preserves_original_input", "scikeel_required_guard_rejects_all_input_rewrites"];
  const valid = !result.error && !result.signal && (phase === "red"
    ? result.status === 101 && expectedFailures.every(name => output.includes(`${name} ... FAILED`))
    : phase === "green" && result.status === 0 && output.includes("8 passed; 0 failed"));
  if (!valid) throw new Error(`Rust regression ${phase} did not produce the required actual parser evidence`);
  return true;
}

export function reconcileWorkspaceVersions(lock) {
  const result = structuredClone(lock);
  const local = result.package?.filter(value => !value.source) ?? [];
  if (result.version !== 4 || local.length !== 155 || local.some(value => value.version !== "0.0.0"))
    throw new Error("Unexpected native workspace version inputs");
  // The release tag changes workspace Cargo.toml, but leaves local lock entries at 0.0.0.
  for (const entry of local) entry.version = "0.157.1";
  return result;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd = source, extra = {}) {
  const { stdio, ...environment } = extra;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 ** 20,
    env: { ...process.env, ...environment }, ...(stdio ? { stdio } : {}) });
  if (result.error || result.signal || result.status !== 0) throw new Error(`Native guard preparation failed: ${command}`);
  return result.stdout?.trim();
}

export async function buildGuardRuntime() {
  // CI alone is insufficient: never let a spoofed flag trigger a native build on the production host.
  if (process.env.CI !== "true" || process.platform !== "linux" || totalmem() < 8 * 1024 ** 3 || process.argv.length !== 2)
    throw new Error("Dedicated native CI required");
  const lock = validateGuardLock(JSON.parse(await readFile(join(patches, "required-effect-guard.lock.json"), "utf8")));
  const patch = join(patches, "required-effect-guard.patch");
  const testPatch = join(patches, "required-effect-guard-tests.patch");
  const bwrapPatch = join(patches, "loopback-address.patch");
  if (sha256(await readFile(patch)) !== lock.patchSha256) throw new Error("Native guard patch identity mismatch");
  if (sha256(await readFile(testPatch)) !== lock.testPatchSha256) throw new Error("Native guard test identity mismatch");
  if (sha256(await readFile(bwrapPatch)) !== lock.bwrapPatchSha256) throw new Error("Native sandbox patch identity mismatch");
  if (run("git", ["rev-parse", "HEAD"]) !== lock.upstreamCommit || run("git", ["status", "--porcelain"]))
    throw new Error("Fresh pinned native source required");
  if (!run("rustc", ["--version"], join(source, "codex-rs")).startsWith(`rustc ${lock.rustVersion} `))
    throw new Error("Native compiler identity mismatch");
  const workspaceLock = join(source, "codex-rs/Cargo.lock");
  const originalLock = await readFile(workspaceLock);
  if (sha256(originalLock) !== lock.upstreamLockSha256) throw new Error("Native upstream dependency lock changed");
  const reconciled = stringify(reconcileWorkspaceVersions(parse(originalLock.toString("utf8"))));
  if (sha256(reconciled) !== lock.workspaceLockSha256) throw new Error("Native workspace dependency lock changed");
  await writeFile(workspaceLock, reconciled);
  // Build the vendored helper statically from the same pinned source. Do not
  // depend on the CI host's glibc/libcap being available in the final image.
  run("git", ["apply", "--check", bwrapPatch]);
  run("git", ["apply", bwrapPatch]);
  const epoch = run("git", ["show", "-s", "--format=%ct", lock.upstreamCommit]);
  run("cargo", ["build", "--locked", "--release", "--jobs", "1", "--package", "codex-bwrap", "--bin", "bwrap",
    "--target", "x86_64-unknown-linux-gnu", "--target-dir", "target/bwrap-static"], join(source, "codex-rs"), {
    RUSTFLAGS: `-C target-feature=+crt-static --remap-path-prefix=${source}=/codex-source`,
    CFLAGS: `-ffile-prefix-map=${source}=/codex-source`, PKG_CONFIG_ALL_STATIC: "1", SOURCE_DATE_EPOCH: epoch,
    CODEX_BWRAP_SOURCE_DIR: join(source, "codex-rs/vendor/bubblewrap"), CODEX_SKIP_BWRAP_BUILD: undefined,
    CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_LTO: "false", stdio: "inherit",
  });
  const bwrap = join(source, "codex-rs/target/bwrap-static/x86_64-unknown-linux-gnu/release/bwrap");
  const headers = run("readelf", ["--wide", "--program-headers", "--dynamic", bwrap]);
  if (/\bINTERP\b|\(NEEDED\)/.test(headers)) throw new Error("Native sandbox resource must be statically linked");
  const bwrapSha256 = await digest(bwrap);
  await mkdir(join(repository, ".deploy/native-capabilities/output"), { recursive: true });
  await writeFile(join(repository, ".deploy/native-capabilities/output/bwrap-resource.json"), JSON.stringify({
    schema: 1, source: process.env.GITHUB_SHA, upstreamCommit: lock.upstreamCommit, patchSha256: lock.bwrapPatchSha256,
    rustVersion: lock.rustVersion, static: true, version: run(bwrap, ["--version"]), bwrapSha256,
  }, null, 2) + "\n");
  // A first measurement intentionally stops here until its digest is committed.
  if (bwrapSha256 !== lock.bwrapSha256) throw new Error("Native sandbox resource identity mismatch; review the measured resource before updating its lock");
  await copyFile(bwrap, join(output, "codex-resources/bwrap"));
  const environment = { ...process.env, CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_LTO: "false",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16", CARGO_PROFILE_RELEASE_OPT_LEVEL: "1", CODEX_BWRAP_SHA256: bwrapSha256 };
  const parserIncludes = ["--include=codex-rs/hooks/src/engine/output_parser.rs", "--include=codex-rs/hooks/src/events/pre_tool_use.rs"];
  run("git", ["apply", "--check", ...parserIncludes, testPatch]);
  run("git", ["apply", ...parserIncludes, testPatch]);
  const regressionArgs = ["test", "--locked", "--release", "--jobs", "1", "--package", "codex-hooks", "--lib", "scikeel_required_guard", "--", "--test-threads=1"];
  const regression = phase => {
    const result = spawnSync("cargo", regressionArgs, { cwd: join(source, "codex-rs"), env: environment,
      encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
    process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
    validateRustRegression(result, phase);
  };
  regression("red");
  run("git", ["apply", "--check", patch]);
  run("git", ["apply", patch]);
  run("git", ["apply", "--include=codex-rs/hooks/src/engine/mod_tests.rs", testPatch]);
  regression("green");
  await writeFile(join(repository, ".deploy/native-capabilities/output/rust-regressions.json"),
    JSON.stringify({ schema: 1, source: process.env.GITHUB_SHA, parserRed: true, parserAndHandlerGreen: true,
      testsPassed: 8, testPatchSha256: lock.testPatchSha256 }) + "\n");
  const paths = run("git", ["diff", "--name-only"]).split("\n").sort();
  if (JSON.stringify(paths) !== JSON.stringify(["codex-rs/Cargo.lock", "codex-rs/core/src/hook_runtime.rs", "codex-rs/core/src/tools/registry.rs",
    "codex-rs/hooks/src/engine/mod.rs", "codex-rs/hooks/src/engine/mod_tests.rs", "codex-rs/hooks/src/engine/output_parser.rs", "codex-rs/hooks/src/events/pre_tool_use.rs",
    "codex-rs/vendor/bubblewrap/network.c"]))
    throw new Error("Unexpected native source changes");
  run("cargo", ["build", "--locked", "--release", "--jobs", "1", "--package", "codex-cli", "--bin", "codex"],
    join(source, "codex-rs"), { CARGO_PROFILE_RELEASE_DEBUG: "0", CARGO_PROFILE_RELEASE_LTO: "false",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16", CARGO_PROFILE_RELEASE_OPT_LEVEL: "1", CODEX_BWRAP_SHA256: bwrapSha256, stdio: "inherit" });
  const binary = join(source, "codex-rs/target/release/codex");
  const version = run(binary, ["--version"]);
  if (!version.includes(lock.upstreamVersion)) throw new Error("Native integration version mismatch");
  await mkdir(output, { recursive: true });
  await copyFile(binary, join(output, "codex"));
  await writeFile(join(output, "native-integration.json"), JSON.stringify({ ...lock, target: "x86_64-unknown-linux-gnu",
    binarySha256: await digest(binary), source: process.env.GITHUB_SHA, version }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildGuardRuntime();
