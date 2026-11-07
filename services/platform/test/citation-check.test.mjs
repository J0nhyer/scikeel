import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateCitationCheck } from "../src/citation-check.mjs";
import { ResearchTasks } from "../src/research-tasks.mjs";

const evidenceFiles = new Set(["papers/text/1.txt", "search/raw/2026-11-07-europepmc.json"]);
const exists = async (path) => evidenceFiles.has(path);

function check(overrides = {}) {
  return {
    version: 1,
    references: [
      {
        id: "1", doi: "10.1000/one", metadata: "resolved", retracted: false,
        screening: "include", full_text_status: "pdf-text", full_text_path: "papers/text/1.txt",
      },
      { id: "2", doi: "10.1000/two", metadata: "resolved", retracted: false, screening: "exclude", full_text_status: "unavailable" },
    ],
    claims: [
      {
        claim_id: "c1", section: "3", claim: "The treatment improved recall.",
        citations: ["1"], evidence_level: "pdf-text", support: "supported",
        evidence: "Recall improved by 12 points.", evidence_path: "papers/text/1.txt",
      },
    ],
    usage: { cited: ["1", "2"], uncited: [], unknown: [] },
    summary: { claims: 1, supported: 1, partial: 0, unsupported: 0, unverifiable: 0 },
    ...overrides,
  };
}

const rejects = (value, pattern) =>
  assert.rejects(validateCitationCheck(value, { exists }), (error) => {
    assert.equal(error.reportInvalid, true);
    assert.match(error.message, pattern);
    return true;
  });

test("a valid citation_check.json v1 passes structural validation", async () => {
  const value = await validateCitationCheck(check(), { exists });
  assert.equal(value.version, 1);
  assert.equal(value.claims.length, 1);
  assert.equal(value.claims[0].claim_id, "c1");
  assert.equal(value.usage.unknown.length, 0);
});

test("a metadata-only citation check without claims fails", async () => {
  await rejects(check({ claims: [] }), /claims must contain at least one claim/);
  await rejects(check({ claims: undefined }), /claims must contain at least one claim/);
});

test("an unknown support verdict fails with a field-level error", async () => {
  const value = check();
  value.claims[0].support = "correct";
  await rejects(value, /claims\[0\]\.support must be one of supported, partial, unsupported, unverifiable/);
});

test("an unknown evidence level fails with a field-level error", async () => {
  const value = check();
  value.claims[0].evidence_level = "full-text";
  await rejects(value, /claims\[0\]\.evidence_level must be one of pdf-text, html-text, abstract-only, none/);
});

test("an uncited included reference fails while excluded or maybe rows do not", async () => {
  const uncited = check({
    references: [check().references[0], { id: "2", screening: "include" }],
    usage: { cited: ["1"], uncited: ["2"], unknown: [] },
  });
  await rejects(uncited, /usage\.uncited\[0\].*include/);
  const excluded = check({
    references: [
      check().references[0],
      { id: "2", screening: "exclude" },
      { id: "3", screening: "maybe" },
    ],
    usage: { cited: ["1"], uncited: ["2", "3"], unknown: [] },
  });
  await assert.doesNotReject(validateCitationCheck(excluded, { exists }));
});

test("a claim citation that is not in references fails", async () => {
  const value = check();
  value.claims[0].citations = ["9"];
  await rejects(value, /claims\[0\]\.citations\[0\] "9" is not in references/);
});

test("a full-text claim whose evidence_path is missing fails", async () => {
  const value = check();
  value.claims[0].evidence_path = "papers/text/missing.txt";
  await rejects(value, /claims\[0\]\.evidence_path "papers\/text\/missing\.txt" does not exist/);
  const escaping = check();
  escaping.claims[0].evidence_path = "../outside.txt";
  await rejects(escaping, /claims\[0\]\.evidence_path must be a workspace-relative file path/);
});

test("an abstract-only claim also needs an existing evidence path", async () => {
  const value = check();
  value.claims[0].evidence_level = "abstract-only";
  value.claims[0].evidence_path = "search/raw/2026-11-07-europepmc.json";
  await assert.doesNotReject(validateCitationCheck(value, { exists }));
  const missing = check();
  missing.claims[0].evidence_level = "abstract-only";
  missing.claims[0].evidence_path = "search/raw/absent.json";
  await rejects(missing, /claims\[0\]\.evidence_path "search\/raw\/absent\.json" does not exist/);
});

test("reference full-text status and paths follow the frozen values", async () => {
  const wrongStatus = check();
  wrongStatus.references[0].full_text_status = "abstract-only";
  await rejects(wrongStatus, /references\[0\]\.full_text_status must be one of pdf-text, html-text, scanned, unavailable/);
  const missingPath = check();
  delete missingPath.references[0].full_text_path;
  await rejects(missingPath, /references\[0\]\.full_text_path is required for pdf-text evidence/);
});

test("unknown citations are rejected and every reference must be accounted for", async () => {
  await rejects(check({ usage: { cited: ["1"], uncited: [], unknown: ["42"] } }),
    /usage\.unknown must be empty for delivery/);
  await rejects(check({ usage: { cited: ["1"], uncited: [], unknown: [] } }),
    /references\[1\] "2" must appear in usage\.cited or usage\.uncited/);
});

test("a claim may carry either claim_id or the legacy id field", async () => {
  const value = check();
  delete value.claims[0].claim_id;
  value.claims[0].id = "c1";
  await assert.doesNotReject(validateCitationCheck(value, { exists }));
});

test("a non-v1 check is rejected", async () => {
  await rejects(check({ version: 2 }), /version must be 1/);
});

async function reportFixture(t, report) {
  const root = await mkdtemp(join(tmpdir(), "scikeel-citation-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "workspace", "session");
  await mkdir(join(directory, ".scikeel"), { recursive: true });
  await writeFile(join(directory, ".scikeel/report.json"), JSON.stringify({
    version: 1, execution: 1, status: "running", steps: [], decisions: [], artifacts: [], checks: [],
    ...report,
  }));
  const store = new ResearchTasks({ rootDir: join(root, "records") });
  return { store, task: { execution: 1, reportPath: ".scikeel/report.json", directory } };
}

test("an invalid step status is rejected with a field-level error, not coerced to pending", async (t) => {
  const { store, task } = await reportFixture(t, {
    steps: [{ title: "Search Europe PMC", status: "done" }],
  });
  await assert.rejects(store.parseProgress(task), (error) => {
    assert.equal(error.reportInvalid, true);
    assert.match(error.message, /steps\[0\]\.status must be one of pending, running, completed, failed/);
    assert.match(error.message, /"done"/);
    return true;
  });
  const repaired = await reportFixture(t, {
    steps: [{ title: "Search Europe PMC", status: "completed" }],
  });
  const report = await repaired.store.parseProgress(repaired.task);
  assert.equal(report.steps[0].status, "completed");
});

test("a report step that uses 'step' instead of 'title' names the expected fields", async (t) => {
  const { store, task } = await reportFixture(t, {
    steps: [{ step: "Search Europe PMC", note: "Europe PMC", status: "completed" }],
  });
  await assert.rejects(store.parseProgress(task), (error) => {
    assert.equal(error.reportInvalid, true);
    assert.match(error.message, /steps\[0\]/);
    assert.match(error.message, /"title"/);
    assert.match(error.message, /"status"/);
    assert.match(error.message, /found keys: step, note, status/);
    return true;
  });
});
