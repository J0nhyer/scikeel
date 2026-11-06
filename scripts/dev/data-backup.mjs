import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function absolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || value === "/" || value.endsWith("/")) throw new Error(`invalid ${name}`);
  return value;
}

function relativeDataPath(dataDir) {
  const parent = dirname(dataDir);
  return parent === "/" ? basename(dataDir) : `${basename(parent)}/${basename(dataDir)}`;
}

export function backupPlan({ dataDir, output }) {
  const root = absolute(dataDir, "data directory");
  const archive = absolute(output, "backup path");
  if (archive === root || archive.startsWith(`${root}/`)) throw new Error("backup must be outside the data directory");
  const parent = dirname(root) === "/" ? "/" : dirname(dirname(root));
  return { args: ["-czf", archive, "-C", parent, relativeDataPath(root)] };
}

function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--force") { values.force = true; continue; }
    if (!key.startsWith("--") || args[index + 1] === undefined) throw new Error("invalid backup arguments");
    values[key.slice(2)] = args[++index];
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = options(process.argv.slice(2));
    if (!values["data-dir"] || !values.output) throw new Error("missing --data-dir or --output");
    const plan = backupPlan({ dataDir: resolve(values["data-dir"]), output: resolve(values.output) });
    const envFile = resolve(values["env-file"] ?? ".env.docker");
    const running = spawnSync("docker", ["compose", "--env-file", envFile, "ps", "--status", "running", "--services", "platform"], { encoding: "utf8" });
    if (running.status === 0 && running.stdout.split("\n").includes("platform") && !values.force) {
      throw new Error(`platform is running; stop it first: docker compose --env-file ${envFile} stop platform`);
    }
    await mkdir(dirname(plan.args[1]), { recursive: true, mode: 0o700 });
    const result = spawnSync("tar", plan.args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("backup archive failed");
    console.log(JSON.stringify({ archive: plan.args[1], args: plan.args }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
