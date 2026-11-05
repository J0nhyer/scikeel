import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_FILES = ["runner.mjs", "file-rpc.mjs", "cli-jobs.mjs", "project-environment.py", "science-environment.mjs",
  "collaboration.mjs", "tool-outcome.mjs", "native-tools.mjs", "required-effect-guard.mjs", "native-network.mjs",
  "native-network.py", "broker-config.mjs"];
const entrypoint = `ENTRYPOINT ["/opt/scikeel/tools/bin/node","/opt/scikeel/tools/runner.mjs"]`;

function docker(runImpl, args) {
  const result = runImpl("docker", args, { encoding: "utf8" });
  if (result?.error) throw result.error;
  if (result?.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result?.stderr || result?.stdout || "").trim()}`);
  return String(result.stdout ?? "").trim();
}

export function workerImportArgs({ rootfs, tag, sourceImageDigest }) {
  if (!DIGEST.test(sourceImageDigest ?? "")) throw new Error("invalid source image digest");
  return ["import", "--platform", "linux/amd64",
    "--change", entrypoint,
    "--change", "USER 1000:1000",
    "--change", "LABEL com.scikeel.worker=true",
    "--change", `LABEL com.scikeel.sourceImageDigest=${sourceImageDigest}`,
    rootfs, tag];
}

export function workerManifest({ imageDigest, sourceImageDigest, enabledRuntimes }) {
  return {
    schema: 1,
    imageDigest,
    sourceImageDigest,
    architecture: "linux/amd64",
    variant: "production",
    enabledRuntimes: [...enabledRuntimes],
  };
}

async function overlayImage({ runImpl, tag, overlayDir, sourceImageDigest, osdBinary = null }) {
  const container = `scikeel-worker-import-${process.pid}`;
  try { docker(runImpl, ["rm", "-f", container]); } catch { /* no stale container */ }
  docker(runImpl, ["create", "--name", container, tag]);
  try {
    for (const name of RUNTIME_FILES) {
      const source = join(overlayDir, name);
      await lstat(source);
      docker(runImpl, ["cp", source, `${container}:/opt/scikeel/tools/${name}`]);
    }
    if (osdBinary) {
      await lstat(osdBinary);
      docker(runImpl, ["cp", osdBinary, `${container}:/opt/scikeel/tools/bin/osd`]);
    }
    docker(runImpl, ["commit",
      "--change", entrypoint,
      "--change", "USER 1000:1000",
      "--change", "LABEL com.scikeel.worker=true",
      "--change", `LABEL com.scikeel.sourceImageDigest=${sourceImageDigest}`,
      container, tag]);
  } finally {
    try { docker(runImpl, ["rm", "-f", container]); } catch { /* best-effort cleanup */ }
  }
  return docker(runImpl, ["image", "inspect", "--format", "{{.Id}}", tag]);
}

export async function importWorkerImage({ rootfs, manifestPath, tag, output, runImpl = spawnSync, overlayDir = null, osdBinary = null }) {
  if (typeof rootfs !== "string" || !rootfs.startsWith("/") || typeof manifestPath !== "string" || !manifestPath.startsWith("/") ||
      typeof output !== "string" || !output.startsWith("/") || typeof tag !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(tag)) throw new Error("invalid worker image import configuration");
  if (!(await lstat(rootfs)).isFile() || !(await lstat(manifestPath)).isFile()) throw new Error("worker image artifact is missing");
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!source || source.schema !== 1 || !DIGEST.test(source.imageDigest ?? "") ||
      source.architecture !== "linux/amd64" || source.variant !== "production" ||
      !Array.isArray(source.enabledRuntimes) || source.enabledRuntimes.length === 0 ||
      source.enabledRuntimes.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))) {
    throw new Error("invalid worker source image manifest");
  }
  docker(runImpl, workerImportArgs({ rootfs, tag, sourceImageDigest: source.imageDigest }));
  let imageDigest = docker(runImpl, ["image", "inspect", "--format", "{{.Id}}", tag]);
  if (overlayDir !== null) {
    imageDigest = await overlayImage({ runImpl, tag, overlayDir: resolve(overlayDir), sourceImageDigest: source.imageDigest, osdBinary });
  }
  if (!DIGEST.test(imageDigest)) throw new Error("invalid imported worker image ID");
  const manifest = workerManifest({ imageDigest, sourceImageDigest: source.imageDigest, enabledRuntimes: source.enabledRuntimes });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ tag, imageDigest, sourceImageDigest: source.imageDigest }));
  return manifest;
}

function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("invalid worker image import arguments");
    values[args[index].slice(2)] = args[index + 1];
  }
  if (!values.rootfs || !values.manifest || !values.tag || !values.output) throw new Error("missing worker image import arguments");
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = options(process.argv.slice(2));
    await importWorkerImage({
      rootfs: resolve(values.rootfs),
      manifestPath: resolve(values.manifest),
      tag: values.tag,
      output: resolve(values.output),
      overlayDir: resolve(values.overlay ?? join(repo, "runtime", "sandbox")),
      osdBinary: values.osd ? resolve(values.osd) : null,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
