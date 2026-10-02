// Test-image entrypoint only. Never include this module in a production image.
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function scienceProbe() {
  const result = spawnSync("/opt/scikeel/science/bin/python", ["-c", `
import os
import numpy, pandas, scipy, matplotlib, sklearn, statsmodels, sympy, nbformat
matplotlib.use('Agg')
from matplotlib import pyplot
pyplot.plot([1,2,3],[1,4,9])
pyplot.savefig('/workspace/figure.png')
assert not os.path.exists('/workspace/.venv')
`], { timeout: 30000, maxBuffer: 65536,
    env: { PATH: "/opt/scikeel/science/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/workspace",
      PYTHONDONTWRITEBYTECODE: "1", MPLCONFIGDIR: "/workspace/.matplotlib",
      OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" } });
  if (result.error || result.signal || result.status !== 0) throw new Error("scientific baseline import failed");
  let rejected = false;
  try { await writeFile("/opt/scikeel/baseline/forbidden-write", "synthetic"); }
  catch { rejected = true; }
  if (!rejected) throw new Error("baseline is writable");
  return { imports: true, figure: true, noPrivateVenv: true, baselineWriteRejected: true };
}

export async function runProbeEntry(path) {
  if (path !== "/opt/scikeel/test/case.json") throw new Error("untrusted probe manifest");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifest;
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.uid !== 0 || (meta.mode & 0o022) || meta.size > 65536)
      throw new Error("untrusted probe manifest");
    manifest = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  if (manifest.schema !== 1 || manifest.synthetic !== true || manifest.case !== "science-image")
    throw new Error("unsupported synthetic probe");
  console.log(JSON.stringify(await scienceProbe()));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runProbeEntry(process.argv[2]); }
  catch { console.error("Synthetic image probe failed"); process.exitCode = 1; }
}
