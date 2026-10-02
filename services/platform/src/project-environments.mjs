import { posix } from "node:path";

function canonical(path) {
  return typeof path === "string" && path.startsWith("/") && path !== "/" && !/[\0\\]/.test(path) && posix.normalize(path) === path && !path.endsWith("/");
}
// This record must come from secure inspection inside the tenant, never from a public request.
export function selectPythonEnvironment(info) {
  if (!info || info.owned !== true || !canonical(info.projectDir)) throw new Error("environment is outside the owned project");
  if (!/^sha256:[a-f0-9]{64}$/.test(info.imageDigest ?? "") || info.basePython !== "/opt/scikeel/science/bin/python")
    throw new Error("unverified scientific baseline");
  if (info.venvState === "absent") return Object.freeze({ kind: "base", python: info.basePython, imageDigest: info.imageDigest });
  if (info.venvState !== "valid" || info.venvPython !== `${info.projectDir}/.venv/bin/python`)
    throw new Error("private environment is invalid; approve a rebuild");
  return Object.freeze({ kind: "private", python: info.venvPython, imageDigest: info.imageDigest });
}
