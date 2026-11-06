import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function usageReport({ duOutput, dfOutput }) {
  const data = String(duOutput).trim().split(/\s+/)[0];
  const filesystem = String(dfOutput).trim().replace(/\s+/g, " ");
  if (!data || !filesystem) throw new Error("invalid usage report");
  return { data, filesystem };
}

function option(args) {
  const index = args.indexOf("--data-dir");
  if (index === -1 || args[index + 1] === undefined) throw new Error("missing --data-dir");
  const value = args[index + 1];
  if (!isAbsolute(value) || value === "/" || value.endsWith("/")) throw new Error("invalid data directory");
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const dataDir = option(process.argv.slice(2));
    const du = spawnSync("du", ["-sh", dataDir], { encoding: "utf8" });
    if (du.status !== 0) throw new Error((du.stderr || "du failed").trim());
    const df = spawnSync("docker", ["system", "df"], { encoding: "utf8" });
    if (df.status !== 0) throw new Error((df.stderr || "docker system df failed").trim());
    console.log(JSON.stringify(usageReport({ duOutput: du.stdout, dfOutput: df.stdout })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
