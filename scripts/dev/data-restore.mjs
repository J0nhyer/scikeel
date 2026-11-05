import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--replace") { values.replace = true; continue; }
    if (!args[index].startsWith("--") || args[index + 1] === undefined) throw new Error("invalid restore arguments");
    values[args[index].slice(2)] = args[++index];
  }
  return values;
}

function relativeDataPath(dataDir) {
  const parent = dirname(dataDir);
  return parent === "/" ? basename(dataDir) : `${basename(parent)}/${basename(dataDir)}`;
}

function verifyArchive(archive, dataDir) {
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error((listing.stderr || "archive is unreadable").trim());
  const entries = listing.stdout.split("\n").filter(Boolean);
  const expected = relativeDataPath(dataDir);
  if (!entries.length || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes("..") ||
      (entry !== expected && !entry.startsWith(`${expected}/`)))) throw new Error("archive does not contain the data root");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = options(process.argv.slice(2));
    if (!values.archive || !values["data-dir"]) throw new Error("missing --archive or --data-dir");
    const archive = resolve(values.archive);
    const dataDir = resolve(values["data-dir"]);
    if (!isAbsolute(archive) || !isAbsolute(dataDir) || dataDir === "/" || dataDir.endsWith("/"))
      throw new Error("invalid restore path");
    verifyArchive(archive, dataDir);
    let entries = [];
    try { entries = await readdir(dataDir); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (entries.length && !values.replace) throw new Error("destination is not empty; use --replace");
    if (values.replace) await rm(dataDir, { recursive: true, force: true });
    const parent = dirname(dataDir) === "/" ? "/" : dirname(dirname(dataDir));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const result = spawnSync("tar", ["-xzf", archive, "-C", parent], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("restore extraction failed");
    const uid = values.uid; const gid = values.gid;
    if (uid !== undefined || gid !== undefined) {
      if (process.getuid?.() !== 0) throw new Error("ownership restore requires root");
      const chown = spawnSync("chown", ["-R", `${uid ?? 0}:${gid ?? 0}`, dataDir], { stdio: "inherit" });
      if (chown.status !== 0) throw new Error("ownership restore failed");
    }
    console.log(JSON.stringify({ restored: dataDir, archive }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
