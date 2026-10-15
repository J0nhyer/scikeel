import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ManagedCodexProfile } from "./cli-profile.mjs";

const fail = () => { throw Object.assign(new Error("invalid_service_profile_operation"), { code: "invalid_service_profile_operation" }); };
const nested = (parent, child) => { const path = relative(parent, child); return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };

async function main() {
  let parsed;
  try { parsed = parseArgs({ allowPositionals: true, strict: true, options: {
    "data-dir": { type: "string" }, source: { type: "string" }, "expected-revision": { type: "string" },
  } }); } catch { fail(); }
  const { values, positionals } = parsed, operation = positionals[0];
  if (positionals.length !== 1 || !["initialize", "synchronize"].includes(operation) ||
      !isAbsolute(values["data-dir"] ?? "") || !isAbsolute(values.source ?? "") ||
      operation === "initialize" && values["expected-revision"] !== undefined ||
      operation === "synchronize" && !values["expected-revision"]) fail();
  const dataDir = resolve(values["data-dir"]), codexHome = resolve(values.source);
  if (nested(dataDir, codexHome) || nested(codexHome, dataDir)) fail();
  const service = new ManagedCodexProfile({ home: join(dataDir, "codex-service") });
  const current = operation === "initialize" ? await service.initializeFromSource({ codexHome })
    : await service.synchronizeFromSource({ codexHome, expectedRevision: values["expected-revision"] });
  console.log(JSON.stringify({ operation, status: current.status, sourceRevision: current.sourceRevision,
    identityRevision: current.identityRevision, catalogRevision: current.catalogRevision, models: current.models.map(model => model.id) }));
}

try { await main(); }
catch (error) {
  const codes = new Set(["invalid_service_profile_operation", "unsafe_service_profile", "service_profile_unavailable",
    "service_profile_initialized", "profile_revision_conflict", "service_profile_busy", "service_profile_source_changed"]);
  console.error(JSON.stringify({ error: codes.has(error?.code) ? error.code : "service_profile_unavailable" }));
  process.exitCode = 1;
}
