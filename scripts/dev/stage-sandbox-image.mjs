import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, statfs } from "node:fs/promises";
import { posix, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hex = /^[a-f0-9]{64}$/;
const pinned = async (path, variable) => (await readFile(join(repo, path), "utf8"))
  .match(new RegExp(`${variable}="\\$\\{${variable}:-([^}]+)\\}"`))?.[1];
const opencodeVersion = await pinned("scripts/dev/fetch-opencode.sh", "OPENCODE_VERSION");
const uvVersion = await pinned("scripts/dev/fetch-uv.sh", "UV_VERSION");

export function validateImageManifest(v) {
  if (!v || v.schema !== 1 || v.name !== "science-v1" || !["probe", "production"].includes(v.variant) ||
      !hex.test(v.rootfsSha256 ?? "") || v.imageDigest !== `sha256:${v.rootfsSha256}` ||
      !hex.test(v.baselineLockSha256 ?? "") || !hex.test(v.toolLockSha256 ?? ""))
    throw new Error("immutable image identities required");
  if (v.architecture !== "linux/amd64" || !/^3\.12\.\d+$/.test(v.python ?? "") || v.uv !== uvVersion ||
      !Number.isSafeInteger(v.fileCount) || v.fileCount < 1 || v.fileCount > 100000 ||
      !Number.isSafeInteger(v.uncompressedBytes) || v.uncompressedBytes < 1 || v.uncompressedBytes > 2 * 1024 ** 3)
    throw new Error("invalid image architecture, inventory or pinned environment");
  if (v.provenance?.repository !== "J0nhyer/scikeel" ||
      !/^[a-f0-9]{40}$/.test(v.provenance?.commit ?? "") || v.provenance?.workflow !== "sandbox-image.yml")
    throw new Error("invalid image provenance");
  if (!Array.isArray(v.enabledRuntimes) || !v.enabledRuntimes.includes("opencode") ||
      v.enabledRuntimes.some((name) => !["opencode", "codex", "claude"].includes(name)))
    throw new Error("invalid runtime inventory");
  for (const name of ["osd", "opencode", "node", "uv", "python", "git", ...v.enabledRuntimes]) {
    const tool = v.tools?.[name];
    if (!tool || !hex.test(tool.sha256 ?? "") || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(tool.version ?? ""))
      throw new Error("missing immutable tool identity");
    validateArchiveEntry({ path: tool.path, type: "file", size: 1 });
  }
  if (v.tools.opencode.version !== opencodeVersion || v.tools.uv.version !== v.uv || v.tools.python.version !== v.python)
    throw new Error("pinned tool version mismatch");
  if (v.variant === "production" && v.testEntryPoint) throw new Error("invalid production test entrypoint");
  if (v.variant === "production") {
    const paths = ["opt/scikeel/tools/runner.mjs", "opt/scikeel/tools/file-rpc.mjs", "opt/scikeel/tools/cli-jobs.mjs", "opt/scikeel/tools/project-environment.py"];
    if (!v.runnerFiles || Object.keys(v.runnerFiles).sort().join(",") !== paths.sort().join(",") ||
        Object.values(v.runnerFiles).some((value) => !hex.test(value))) throw new Error("missing immutable runner identity");
  }
  return v;
}

export function validateBuildContext(paths) {
  const fixed = new Set(["Dockerfile", "pyproject.toml", "uv.lock", "tool-lock.json"]);
  for (const path of paths) {
    if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        !(fixed.has(path) || /^tools\/bin\/(osd|opencode|node|uv|codex|claude)$/.test(path) ||
          /^tools\/resources\/skills-core\/[^/]+\/.+/.test(path) || /^tools\/(?:probe-entry|runner|file-rpc|cli-jobs)\.mjs$/.test(path) || path === "tools/project-environment.py") ||
        /(^|\/)(\.[^/]+|auth\.json|credentials?\.json|secrets?)(\/|$)|\.(key|pem|p12)$/i.test(path))
      throw new Error("forbidden image build context entry");
  }
}

export function validateArchiveEntry(entry) {
  const path = entry.path;
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0") || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !["file", "directory", "symlink", "hardlink"].includes(entry.type) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 2 * 1024 ** 3)
    throw new Error("unsafe image archive entry");
  if (["symlink", "hardlink"].includes(entry.type)) {
    if (typeof entry.link !== "string" || !entry.link || entry.link.includes("\0") || entry.link.includes("\\"))
      throw new Error("unsafe image archive link");
    // Absolute in-image links are rewritten relative during extraction; they
    // never resolve against the host's root while staging.
    const target = entry.link.startsWith("/") ? entry.link.slice(1)
      : entry.type === "hardlink" ? entry.link : posix.join(posix.dirname(path), entry.link);
    const normalized = posix.normalize(target);
    if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/"))
      throw new Error("unsafe image archive link");
  }
  return entry;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function regular(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximum) throw new Error("invalid artifact file");
  return metadata;
}
function command(binary, args, timeout = 30000) {
  const result = spawnSync(binary, args, { cwd: repo, encoding: "utf8", timeout, maxBuffer: 32 * 1024 ** 2 });
  if (result.error || result.signal || result.status !== 0) throw new Error("image verification prerequisite failed");
  return result.stdout;
}
export async function stageImage(args) {
  if (args.length !== 3 || args[0] !== "--manifest" || !["--dry-run", "--install"].includes(args[2]))
    throw new Error("Expected --manifest PATH --dry-run|--install");
  const manifestPath = resolve(args[1]);
  await regular(manifestPath, 1024 * 1024);
  const manifest = validateImageManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const artifactRoot = dirname(manifestPath);
  const archive = join(artifactRoot, "rootfs.tar.gz");
  const lock = join(artifactRoot, "uv.lock");
  const toolLock = join(artifactRoot, "tool-lock.json");
  const bundle = join(artifactRoot, "attestation.jsonl");
  for (const path of [archive, lock, toolLock, bundle]) await regular(path, path === archive ? 2 * 1024 ** 3 : 32 * 1024 ** 2);
  if (await digest(archive) !== manifest.rootfsSha256 || await digest(lock) !== manifest.baselineLockSha256 ||
      await digest(toolLock) !== manifest.toolLockSha256) throw new Error("immutable artifact digest mismatch");
  // Both manifest and rootfs must carry CI attestations from the exact workflow.
  for (const artifact of [manifestPath, archive]) {
    command("gh", ["attestation", "verify", artifact, "--repo", "J0nhyer/scikeel", "--bundle", bundle,
      "--signer-workflow", "J0nhyer/scikeel/.github/workflows/sandbox-image.yml", "--deny-self-hosted-runners"]);
  }
  const listing = JSON.parse(command("python3", [join(repo, "scripts/dev/inspect-sandbox-archive.py"), archive]));
  for (const entry of listing.entries) validateArchiveEntry(entry);
  for (const tool of Object.values(manifest.tools)) {
    if (listing.toolHashes?.[tool.path] !== tool.sha256) throw new Error("immutable installed tool digest mismatch");
  }
  for (const [path, sha] of Object.entries(manifest.runnerFiles ?? {}))
    if (listing.toolHashes?.[path] !== sha) throw new Error("immutable installed runner digest mismatch");
  if (manifest.variant === "production" && listing.entries.some((entry) => entry.path === "opt/scikeel/tools/probe-entry.mjs"))
    throw new Error("invalid production test entrypoint");
  if (listing.fileCount !== manifest.fileCount || listing.uncompressedBytes !== manifest.uncompressedBytes)
    throw new Error("immutable archive inventory mismatch");
  const disk = await statfs(artifactRoot);
  if (Number(disk.bavail) * Number(disk.bsize) < manifest.uncompressedBytes + 600 * 1024 ** 2)
    throw new Error("insufficient image staging storage");
  if (args[2] === "--install") {
    const installed = JSON.parse(command("sudo", ["-n", "/usr/bin/python3", "/usr/local/lib/scikeel/install-sandbox-image.py", artifactRoot], 180000));
    if (installed.installed !== true || installed.imageDigest !== manifest.imageDigest) throw new Error("invalid installed image identity");
  }
  console.log(JSON.stringify({ verified: true, dryRun: args[2] === "--dry-run", imageDigest: manifest.imageDigest,
    fileCount: listing.fileCount, uncompressedBytes: listing.uncompressedBytes }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await stageImage(process.argv.slice(2)); }
  catch (error) {
    console.error(error.code === "ENOENT" ? "Image prerequisite: CI artifact is missing" : "Image prerequisite: artifact verification failed");
    process.exitCode = 1;
  }
}
