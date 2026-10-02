// CI-only artifact measurement. Never call this on the shared cloud server.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateBuildContext, validateImageManifest } from "./stage-sandbox-image.mjs";

export function validateSourceImages(sources) {
  if (!/^(?:docker\.io\/library\/)?python@sha256:[a-f0-9]{64}$/.test(sources?.python ?? "") ||
      !/^ghcr\.io\/astral-sh\/uv@sha256:[a-f0-9]{64}$/.test(sources?.uv ?? ""))
    throw new Error("invalid source image identity");
  return sources;
}
export function toolVersionArguments(name) {
  if (!["osd", "opencode", "node", "uv"].includes(name)) throw new Error("unsupported measured tool");
  return [name === "osd" ? "version" : "--version"];
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 ** 2 });
  if (result.error || result.signal || result.status !== 0) throw new Error(`CI image measurement failed: ${binary.split("/").pop()}`);
  return result.stdout.trim();
}
async function files(root, prefix = "") {
  const output = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("unsafe CI context");
    if (info.isDirectory()) output.push(...await files(root, relative));
    else output.push(relative);
  }
  return output;
}
export async function prepareImage(args) {
  if (process.env.CI !== "true" || args.length < 2 || args.length > 3 || (args[2] && args[2] !== "--manifest"))
    throw new Error("dedicated CI image measurement required");
  const [context, artifacts] = args.map((path, index) => index < 2 ? resolve(path) : path);
  const variant = process.env.SCIKEEL_IMAGE_VARIANT ?? "probe";
  if (!["probe", "production"].includes(variant)) throw new Error("invalid science image variant");
  const sources = validateSourceImages({ python: (await readFile(join(artifacts, "python-image.txt"), "utf8")).trim(),
    uv: (await readFile(join(artifacts, "uv-image.txt"), "utf8")).trim() });
  validateBuildContext(await files(context));
  const tools = {};
  for (const name of ["osd", "opencode", "node", "uv"]) {
    const path = join(context, "tools/bin", name);
    const version = run(path, toolVersionArguments(name)).match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/)?.[0];
    if (!version) throw new Error("unmeasured CI tool version");
    tools[name] = { version, sha256: await sha256(path), path: `opt/scikeel/tools/bin/${name}` };
  }
  if (!args[2]) {
    const lock = { schema: 1, sources, tools, baselineLockSha256: await sha256(join(context, "uv.lock")) };
    await writeFile(join(context, "tool-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    await writeFile(join(artifacts, "tool-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    return;
  }
  const program = `import hashlib,json,subprocess
subprocess.check_output(['/opt/scikeel/tools/bin/osd','version'],text=True)
out={}
for name,path in [('python','/usr/local/bin/python3.12'),('uv','/usr/local/bin/uv'),('git','/usr/bin/git')]:
 version=subprocess.check_output([path,'--version'],text=True).strip()
 with open(path,'rb') as file: digest=hashlib.file_digest(file,'sha256').hexdigest()
 out[name]={'reported':version,'sha256':digest,'path':path[1:]}
print(json.dumps(out))`;
  const measured = JSON.parse(run("docker", ["run", "--rm", "--network=none", "--read-only",
    "--memory=128m", "--memory-swap=192m", "--pids-limit=64", "--cpus=1", "--entrypoint",
    "/usr/local/bin/python3.12", "scikeel-science-probe:ci", "-c", program]));
  for (const [name, value] of Object.entries(measured)) {
    const version = value.reported.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) throw new Error("unmeasured CI image tool version");
    tools[name] = { version, sha256: value.sha256, path: value.path };
  }
  const inspector = join(dirname(fileURLToPath(import.meta.url)), "inspect-sandbox-archive.py");
  const archive = join(artifacts, "rootfs.tar.gz");
  const inventory = JSON.parse(run("python3", [inspector, archive]));
  const digest = await sha256(archive);
  const runnerFiles = {};
  if (variant === "production") for (const name of ["runner.mjs", "file-rpc.mjs", "cli-jobs.mjs", "project-environment.py"])
    runnerFiles[`opt/scikeel/tools/${name}`] = await sha256(join(context, "tools", name));
  const manifest = { schema: 1, name: "science-v1", variant, architecture: "linux/amd64",
    rootfsSha256: digest, imageDigest: `sha256:${digest}`, python: tools.python.version, uv: tools.uv.version,
    baselineLockSha256: await sha256(join(artifacts, "uv.lock")), toolLockSha256: await sha256(join(artifacts, "tool-lock.json")),
    fileCount: inventory.fileCount, uncompressedBytes: inventory.uncompressedBytes, tools, enabledRuntimes: ["opencode"],
    ...(variant === "probe" ? { testEntryPoint: "/opt/scikeel/tools/probe-entry.mjs" } : { runnerFiles }),
    provenance: { repository: "J0nhyer/scikeel", commit: process.env.GITHUB_SHA, workflow: "sandbox-image.yml" } };
  validateImageManifest(manifest);
  await writeFile(join(artifacts, "image-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareImage(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
