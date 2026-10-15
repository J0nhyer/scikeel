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
      !/^[a-f0-9]{64}$/.test(lock.upstreamLockSha256 ?? "") || !/^[a-f0-9]{64}$/.test(lock.workspaceLockSha256 ?? "") ||
      lock.lockFormat !== "smol-toml@1.9.0" ||
      lock.bwrapSha256 !== "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c")
    throw new Error("Invalid pinned native guard inputs");
  return lock;
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
  if (sha256(await readFile(patch)) !== lock.patchSha256) throw new Error("Native guard patch identity mismatch");
  if (run("git", ["rev-parse", "HEAD"]) !== lock.upstreamCommit || run("git", ["status", "--porcelain"]))
    throw new Error("Fresh pinned native source required");
  if (!run("rustc", ["--version"], join(source, "codex-rs")).startsWith(`rustc ${lock.rustVersion} `))
    throw new Error("Native compiler identity mismatch");
  const bwrapSha256 = await digest(join(output, "codex-resources/bwrap"));
  if (bwrapSha256 !== lock.bwrapSha256) throw new Error("Native sandbox resource identity mismatch");
  run("git", ["apply", "--check", patch]);
  run("git", ["apply", patch]);
  const workspaceLock = join(source, "codex-rs/Cargo.lock");
  const originalLock = await readFile(workspaceLock);
  if (sha256(originalLock) !== lock.upstreamLockSha256) throw new Error("Native upstream dependency lock changed");
  const reconciled = stringify(reconcileWorkspaceVersions(parse(originalLock.toString("utf8"))));
  if (sha256(reconciled) !== lock.workspaceLockSha256) throw new Error("Native workspace dependency lock changed");
  await writeFile(workspaceLock, reconciled);
  const paths = run("git", ["diff", "--name-only"]).split("\n").sort();
  if (JSON.stringify(paths) !== JSON.stringify(["codex-rs/Cargo.lock", "codex-rs/core/src/hook_runtime.rs", "codex-rs/hooks/src/events/pre_tool_use.rs"]))
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
