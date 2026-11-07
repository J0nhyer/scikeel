# Research Flow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Web research flow use Europe PMC, download and parse open-access PDFs, require per-claim citation support and citation usage, validate the machine-readable citation check, and return actionable delivery-report errors.

**Architecture:** Skill content defines the research contract (Europe PMC, OA full text, claim support, criteria/venue/archive). The OpenCode runtime gains a managed `webfetch` download mode that writes PDFs into the session workspace; the worker image gains `pypdf` and a `large-file` PDF helper. The platform validates `citation_check.json` structurally and reports invalid report fields by name.

**Tech Stack:** OpenCode 1.18.32 + Bun 1.3.14, Effect/TypeScript, Node 22, Python 3.12 + pypdf, Docker worker image, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-07-research-flow-hardening-design.md`

## Global Constraints

- Web-gateway only. Do not change desktop-only behavior.
- Do not repair the 2026-11-07 session's `review.md`, `references.csv`, or `citation_check.md`; only fix the process.
- PDF full text is the selected option (A). The OpenCode patch and worker image must be rebuilt for both local acceptance and cloud deployment.
- Europe PMC replaces the PubMed-only MEDLINE path. Do not keep a dead `eutils.ncbi.nlm.nih.gov` step.
- Full text/PDF is OpenCode-only. Codex native tools are unchanged and documented as a limitation; do not send `savePath` to Codex.
- Do not use Unpaywall unless the user supplies a real contact email; never fabricate one. Default discovery is Europe PMC → OpenAlex → Semantic Scholar → arXiv.
- Diagnostics stay in the tool result and `search_log.md`; no UI diagnostic field or outcome-schema change.
- Citation usage applies to `screening=include` rows only; excluded/maybe rows are not required to be cited.
- Recommended scope: claim support, delivery errors, full text, Europe PMC, citation usage, pre-specified screening criteria, raw-response archive. Venue quality is a preference, never a hard filter.
- No fabricated citation, quotation, page, abstract, or full-text claim. `full-text` is used only after parsed text exists.
- Keep the managed network, sandbox permissions, workspace isolation, and delivery gate intact. Do not bypass or weaken them.
- The worker shell has no direct external network. All downloads go through `webfetch` and the managed egress broker.
- `runtime/skills/core/**`, `runtime/sandbox/**`, and `runtime/opencode-patches/**` are worker-image inputs; the platform source and worker image must be deployed from the same commit.
- The local overlay image is local-only and unattested. Never use its digest in production.
- Run Web/platform/runtime builds and tests through the project task runners; use `TMPDIR=$PWD/.deploy/test-tmp` on macOS. Do not run unbounded heavy jobs on the 3.3 GiB cloud host.
- All project files and code are English.

## Review Focus

- `savePath` path traversal, absolute paths, symlinked parents, and external-directory escapes must fail; a download must never write outside the session workspace.
- PDF responses over the 32 MiB cap, slow responses, permission rejection, and non-2xx responses must leave no partial/corrupt artifact and must not put PDF bytes in the model context.
- `citation_check.json` with empty claims, uncited references, unknown citations, or missing evidence paths must fail delivery instead of silently passing.
- Europe PMC OA URL redirects/failures and missing full text must fall back to abstract-only evidence explicitly, never to `full-text` or model memory.
- A local pass with an old OpenCode binary, a stale patch hash, a missing `pypdf` lock entry, or a local-only image digest must not be mistaken for a cloud-ready release.

---

### Task 1: Europe PMC and the pre-specified search contract

**Files:**
- Modify: `runtime/skills/core/literature-review/SKILL.md`
- Test: `services/platform/test/skills.test.mjs`

**Interfaces:**
- Consumes: existing `seedSkills`/`discoverSkills` behavior; the `literature-review` skill is already in `CORE_SKILLS`.
- Produces: the skill content later tasks reference for source names, query URLs, reference columns, and the pre-search contract.

- [ ] **Step 1: Write the failing skill-content assertions**

Add to the existing "ships the literature review and citation reviewer skills" test (or a new test in the same file) assertions that the `literature-review` content contains:
`Europe PMC`, `eutils.ncbi.nlm.nih.gov` is absent, `fullTextUrlList`, `pmcid`, `full_text_status`, `venue_tier`, `search/raw`, `papers/`, and `question` (the AskQuestion tool).

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: FAIL on the new markers; the old file has PubMed and no Europe PMC/full-text columns.

- [ ] **Step 3: Update the skill content**

In `runtime/skills/core/literature-review/SKILL.md`:

- Replace the PubMed section with Europe PMC:
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<encoded>&format=json&pageSize=25&resultType=core`
  and list the fields `pmid`, `pmcid`, `doi`, `abstractText`, `isOpenAccess`, `hasPDF`, `fullTextUrlList`.
- Add the pre-search contract section: topic, population/method, date range, language, publication types, inclusion/exclusion, and a venue preference (`top`, `field-core`, `other`). Record it at the top of `search_log.md` before the first query.
- Extend the `references.csv` schema to:
  `id,title,authors,year,venue,venue_tier,doi,pmid,pmcid,arxiv_id,source_url,abstract_status,full_text_status,full_text_url,full_text_path,screening`.
  `abstract_status` is `abstract-only|none` (the old ambiguous `full-text`
  value is removed); `full_text_status` is
  `pdf-text|html-text|scanned|unavailable`.
- Add the raw archive paths `search/raw/<timestamp>-<source>.json`, `papers/`, and `papers/text/`; keep them after the run.
- Add the `question` tool instruction: after screening, when the core set or paywalled priorities are ambiguous, ask the user; do not silently choose abstract-only for everything.
- Remove the PubMed-only URL and the claim that it is the default MEDLINE path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/skills/core/literature-review/SKILL.md services/platform/test/skills.test.mjs
git commit -m "feat(skills): use Europe PMC and pre-specify the literature search"
```

---

### Task 2: Full-text acquisition contract and reference fields

**Files:**
- Modify: `runtime/skills/core/literature-review/SKILL.md`
- Modify: `runtime/skills/core/research-workflow/SKILL.md` (delivery prepare deliverables)
- Test: `services/platform/test/skills.test.mjs`

**Interfaces:**
- Consumes: Task 1's source/columns and the `webfetch` `savePath` argument (Task 5); the `large-file` PDF helper (Task 6).
- Produces: the exact full-text flow, `full_text_status` values, the `question` decision point, and the `research_delivery` prepare list used by Task 7.

- [ ] **Step 1: Write the failing assertions**

In `services/platform/test/skills.test.mjs`, assert the literature skill contains `Europe PMC`, `Semantic Scholar`, `openAccessPdf`, `savePath`, `papers/`, `pdf-text`, `scanned`, `unavailable`, and `question`; assert the research-workflow skill's delivery prepare list contains `citation_check.md` and `citation_check.json`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: FAIL on the new markers.

- [ ] **Step 3: Implement the full-text contract**

In `literature-review/SKILL.md`, add the acquisition order: Europe PMC `fullTextUrlList` → OpenAlex `best_oa_location`/`open_access.oa_url` → Semantic Scholar `openAccessPdf` → arXiv PDF. Unpaywall is optional only with a real user-supplied email; never fabricate one. For each core paper (no fixed 5–10 default: usually 2–3, adaptive to the topic; the user prompt or field conventions can specify a different count; record the chosen set in `search_log.md`; use `question` when ambiguous):

- `webfetch` with `savePath: papers/<safe-id>.pdf` and `timeout: 120`.
- Parse with the `large-file` PDF helper into `papers/text/<safe-id>.txt`.
- Record `full_text_status` as `pdf-text`, `html-text`, `scanned`, or `unavailable`.
- If no open-access copy exists, mark `unavailable`; use the abstract; when the user needs the paper, ask via `question` whether to proceed or upload the PDF.
- Never label an abstract-only claim as full text.

In `research-workflow/SKILL.md`, state that a literature delivery prepares `review.md`, `references.csv`, `search_log.md`, `citation_check.md`, and `citation_check.json`, and that the citation check is a required artifact, not optional.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/skills/core/literature-review/SKILL.md runtime/skills/core/research-workflow/SKILL.md services/platform/test/skills.test.mjs
git commit -m "feat(skills): specify open-access full-text acquisition"
```

---

### Task 3: Claim support, citation usage, and the machine-readable check

**Files:**
- Modify: `runtime/skills/core/citation-reviewer/SKILL.md`
- Test: `services/platform/test/skills.test.mjs`

**Interfaces:**
- Consumes: Task 2's full-text statuses and paths; `review.md` claims and `references.csv` IDs.
- Produces: the `citation_check.json` v1 schema consumed by Task 4; the human `citation_check.md` table; the `review` block findings.

- [ ] **Step 1: Write the failing assertions**

In `services/platform/test/skills.test.mjs`, assert the citation skill contains `citation_check.json`, `"usage"`, `uncited`, `unknown`, `supported`, `partial`, `unsupported`, `unverifiable`, `evidence_path`, and `full-text`/`abstract-only`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: FAIL on the new markers; the current skill has claim-support prose but no JSON contract or usage gate.

- [ ] **Step 3: Implement the citation contract**

In `citation-reviewer/SKILL.md`:

- Require a claims table for every claim that carries `[n]`: `claim_id`, `section`, `claim`, `citations`, `evidence_level`, `support`, `evidence`, `evidence_path`.
- Define `support` as `supported|partial|unsupported|unverifiable`; `evidence_level` as `pdf-text|html-text|abstract-only|none`.
- Require `citation_check.json` v1 with `references`, `claims`, `usage`, and `summary` in the shape from the spec.
- Write the artifacts when auditing a workspace document; keep exactly one
  `review` block as the last thing in the reply.
- Require `usage.uncited` and `usage.unknown` empty for delivery for
  `screening=include` rows; excluded/maybe rows are not required to be cited.
  Uncited included references are a process failure, not a silent omission.
- Keep the metadata/retraction table; cross-check with Europe PMC/OpenAlex/Crossref; do not require PubMed.
- Emit `warn` for partial/unverifiable, `error` for unsupported, `ok` only for supported; never say "correct".
- Emit `citation_check.md` as the human table and `citation_check.json` as the evidence.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/skills/core/citation-reviewer/SKILL.md services/platform/test/skills.test.mjs
git commit -m "feat(skills): require claim support and citation usage evidence"
```

---

### Task 4: Delivery report and citation-check validation

**Files:**
- Create: `services/platform/src/citation-check.mjs`
- Modify: `services/platform/src/research-tasks.mjs`
- Modify: `services/platform/src/collaboration.mjs`
- Test: `services/platform/test/citation-check.test.mjs` (new)
- Test: `services/platform/test/collaboration-delivery.test.mjs`
- Test: `services/platform/test/skills.test.mjs` (tool/skill markers if the description changes)

**Interfaces:**
- Consumes: the `citation_check.json` schema from Task 3; the `ResearchTasks` workspace artifact reader; the delivery report's `artifacts`/`checks`.
- Produces: `validateCitationCheck(value, {exists})` returning normalized data or throwing a field-level error; `research-tasks.mjs` field-level step errors; a delivery gate that rejects a missing/invalid citation check.

- [ ] **Step 1: Write the failing tests**

In `services/platform/test/citation-check.test.mjs`, test:
- a valid v1 check passes;
- a check with `claims: []` fails;
- a claim with an unknown support value fails;
- an included reference in `usage.uncited` fails; an excluded/maybe reference
  there does not;
- a claim citation not in `references` fails;
- a full-text claim whose `evidence_path` does not exist fails;
- a metadata-only check with no claims fails;
- an invalid step status `"done"` fails with a field-level message.

In `services/platform/test/collaboration-delivery.test.mjs`, add a test that writes a report with `steps: [{"step": "...", "status": "completed"}]` and asserts `delivery.reportError` contains `steps[0]`, `title`, and `status`; repair with `title` and pass.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/citation-check.test.mjs services/platform/test/collaboration-delivery.test.mjs`
Expected: FAIL because `citation-check.mjs` does not exist and the step error is generic.

- [ ] **Step 3: Implement the validator and error**

Create `services/platform/src/citation-check.mjs`:

- `validateCitationCheck(value, {exists})` validates the schema, at least one claim, every claim's support/evidence level, every citation mapping, `usage.unknown`/`usage.uncited` empty, and every non-`none` `evidence_path` via the provided `exists(path)` callback.
- Throw `Object.assign(new Error("citation_check.json claims[3].support must be one of supported, partial, unsupported, unverifiable"), { reportInvalid: true })`-style field errors.

Modify `research-tasks.mjs`:

- Replace the generic steps catch with a check for a non-empty `title` and a valid `status`; include the received keys. Reject an invalid status (no coercion to `pending`).
- Add `readArtifact(owner, path)` (or equivalent) to read the citation check through the same workspace boundary as `artifact`/`evidence`; expose it to the delivery path.
- Keep the existing `missing_progress` issue code for compatibility; the `reportError` message is the actionable part.

Modify `collaboration.mjs` delivery verify:

- Require `citation_check.json` in the delivery's artifacts/deliverables; read it and call `validateCitationCheck`; if invalid, set `reportError` and fail with `failed_checks`.
- Do not let a self-reported `checks` status override a failed structural validation.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/citation-check.test.mjs services/platform/test/collaboration-delivery.test.mjs`
Expected: PASS; the valid report still completes.

- [ ] **Step 5: Commit**

```bash
git add services/platform/src/citation-check.mjs services/platform/src/research-tasks.mjs services/platform/src/collaboration.mjs services/platform/test/citation-check.test.mjs services/platform/test/collaboration-delivery.test.mjs
git commit -m "fix(platform): validate citation checks and report schema errors"
```

---

### Task 5: `webfetch` savePath and PDF download

**Files:**
- Modify: `runtime/opencode-patches/managed-network.ts`
- Modify: `runtime/opencode-patches/network.patch`
- Modify: `runtime/opencode-patches/network.lock.json`
- Modify: `runtime/opencode-patches/network-native.acceptance.mjs`
- Source (staging): `.deploy/opencode-source/packages/opencode/src/tool/webfetch.ts`
- Test: `runtime/opencode-patches/network-native.acceptance.mjs`
- Test: `services/platform/test/managed-network-source.test.mjs` (source assertions)

**Interfaces:**
- Consumes: the managed network client and the OpenCode `webfetch` tool.
- Produces: `webfetch({url, format?, timeout?, savePath?})`; a saved PDF path/bytes/MIME in the tool output; a 32 MiB download cap; an `edit` permission for the save path; path-safety checks.

- [ ] **Step 1: Write the failing acceptance assertions**

In `network-native.acceptance.mjs`, add a case where the fixture model calls:
`{url: "https://science.example/paper.pdf", savePath: "papers/paper.pdf", timeout: 30}`
with a TLS fixture returning `application/pdf` bytes. The test must reply to both the `webfetch` and `edit` permissions, assert the tool output contains the relative path/byte count, read the file from the session workspace, and compare bytes. Add a JSON `savePath` case (`search/raw/probe.json`) that asserts the output is a bounded preview while the raw file contains the full bytes. Add negative cases for `../escape.pdf`, `/tmp/escape.pdf`, a symlinked parent, a >32 MiB `content-length`, and a rejected `edit` permission.

- [ ] **Step 2: Run the test to verify it fails**

Run the source acceptance with the pinned source/Bun (CI or the Linux Bun container):
`OSD_SESSION_TITLE_SOURCE="$PWD/.deploy/opencode-source" SCIKEEL_RUNTIME_BUN=<bun> TMPDIR="$PWD/.deploy/test-tmp" node --test runtime/opencode-patches/network-native.acceptance.mjs`
Expected: FAIL because `savePath` is not in the schema and no file is written.

- [ ] **Step 3: Implement the download mode**

In the staging `packages/opencode/src/tool/webfetch.ts`:

- Add `savePath: Schema.optional(Schema.String)`.
- Validate relative path, ≤512 bytes, no `..`, absolute, NUL/control; resolve against `InstanceState.context.directory`; reject outside or symlinked-parent escapes.
- Ask `webfetch` for the URL and `edit` for the path; use `FSUtil`/`Bun.write` to create parents and write the bytes; publish the normal file events if the tool has the services.
- For `savePath`, use a 32 MiB cap for `content-length` and `arrayBuffer`; for
  a PDF, do not decode/convert it and return a pointer (`path`, `bytes`,
  `mime`, `url`) without the bytes. For a text/JSON response, save the raw
  bytes and return a bounded preview (for example 256 KiB) so the raw archive
  and screening share one request.
- Keep the existing 5 MiB text path unchanged.
- Add a `maxBytes` option to `managedClient` (default 5 MiB; 32 MiB for `savePath`) and use it in `boundedBody`; websearch stays at 2 MiB.
- Add the `savePath` parameter to the tool's `ctx.ask` metadata and to the `webfetch` description.

Update the staging source, regenerate `network.patch` from the diff, update `network.lock.json` `patchSha256`/`combinedPatchSha256`, and run `verifyNetworkInputs`.

- [ ] **Step 4: Run the source acceptance and source tests**

Run the acceptance command from Step 2; expected PASS.
Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/managed-network-source.test.mjs`
Expected: PASS (asserts the env broker URLs and the new savePath marker).

- [ ] **Step 5: Build the runtime binary**

Run the CI build path (`CI=true pnpm runtime:title:build`) or the local-only Linux Bun build used for verification. Verify:
`grep -ac SCIKEEL_BROKER_PROXY_URL <binary>` ≥ 1 and `<binary> --version` = `1.18.32`.
Record the binary hash; do not use a local binary as a production attestation.

- [ ] **Step 6: Commit**

```bash
git add runtime/opencode-patches/managed-network.ts runtime/opencode-patches/network.patch runtime/opencode-patches/network.lock.json runtime/opencode-patches/network-native.acceptance.mjs
git commit -m "feat(runtime): save PDF downloads through managed webfetch"
```

---

### Task 6: PDF parsing and the worker image dependency

**Files:**
- Modify: `runtime/skills/core/large-file/large_file_probe.py`
- Create: `runtime/skills/core/large-file/pdf_text.py`
- Modify: `runtime/skills/core/large-file/SKILL.md`
- Modify: `runtime/sandbox/image/pyproject.toml`
- Modify: `runtime/sandbox/image/uv.lock`
- Test: `services/platform/test/shared-skills.test.mjs`

**Interfaces:**
- Consumes: a downloaded PDF at `papers/<id>.pdf`.
- Produces: a compact PDF pointer from `large_file_probe.py`; bounded extracted text from `pdf_text.py`; `pypdf` in the worker image.

- [ ] **Step 1: Write the failing tests**

In `services/platform/test/shared-skills.test.mjs`, assert `pdf_text.py` exists, the `large-file` skill mentions PDF and `pypdf`, and the probe's supported-format list includes `pdf`. Add a test that runs `large_file_probe.py` on a tiny generated PDF if `pypdf` is available; otherwise assert the pointer contains `pypdf` install guidance.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/shared-skills.test.mjs`
Expected: FAIL on the missing PDF helper/markers.

- [ ] **Step 3: Implement PDF parsing**

- Add `"pypdf"` to `runtime/sandbox/image/pyproject.toml` and regenerate `uv.lock` in the image build context (`uv lock` with the pinned Python 3.12; the CI's `uv lock --locked` must pass).
- In `large_file_probe.py`, detect `.pdf`; use `pypdf.PdfReader` to report page count, metadata, per-page character counts, and a first-page sample; if `pypdf` is missing, return a pointer with an install hint (never raw bytes).
- Create `pdf_text.py` with `--pages A-B`, `--out PATH`, and a default bounded output; extract text with `pypdf`; write to `papers/text/<id>.txt`; do not OCR; report `scanned` when no text layer is found.
- Update `large-file/SKILL.md` with the PDF example and the 2 MiB extracted-text cap.
- Ensure `seedSkills` copies the new helper (the whole skill directory is copied).

- [ ] **Step 4: Run the tests and verify the image dependency**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/shared-skills.test.mjs`
Expected: PASS.
Run in the worker/builder image: `python -c "import pypdf; print(pypdf.__version__)"`
Expected: a version; the CI image build `uv sync --locked` succeeds.

- [ ] **Step 5: Commit**

```bash
git add runtime/skills/core/large-file runtime/sandbox/image/pyproject.toml runtime/sandbox/image/uv.lock services/platform/test/shared-skills.test.mjs
git commit -m "feat(skills): parse downloaded PDFs with pypdf"
```

---

### Task 7: Delivery prepare and the live research flow

**Files:**
- Modify: `runtime/skills/core/research-workflow/SKILL.md`
- Modify: `runtime/sandbox/collaboration.mjs` (tool description/report template)
- Modify: `runtime/skills/core/literature-review/SKILL.md`
- Test: `services/platform/test/skills.test.mjs`
- Test: `services/platform/test/collaboration-delivery.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces: a delivery prepare that includes the citation artifacts; a report template the model can follow; a check title that names claim support; a live flow that downloads/parses/cites.

- [ ] **Step 1: Write the failing assertions**

Assert the research-workflow/literature skill contains:
`citation_check.json`, `prepare` with all five artifacts, `claim support`, and the exact report template `{"title": "...", "status": "completed"}`.
Assert the delivery test's prepare/verify with the citation artifacts passes; a missing citation check fails.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TMPDIR="$PWD/.deploy/test-tmp" node --test services/platform/test/skills.test.mjs services/platform/test/collaboration-delivery.test.mjs`
Expected: FAIL on the new markers/behavior.

- [ ] **Step 3: Implement the delivery integration**

- Update `research-workflow/SKILL.md` and `literature-review/SKILL.md` to prepare all five deliverables and use the exact report step shape.
- Update `runtime/sandbox/collaboration.mjs`'s `research_delivery` description with the minimal `title`/`status` template and the citation check requirement.
- Ensure the report check is titled "citation metadata + claim support" and its evidence is `citation_check.json`; the human `citation_check.md` is also an artifact.
- The report's steps must not mark a failed source as completed; a replaced PubMed attempt is in limitations.

- [ ] **Step 4: Run the tests to verify they pass**

Run the commands from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/skills/core/research-workflow/SKILL.md runtime/skills/core/literature-review/SKILL.md runtime/sandbox/collaboration.mjs services/platform/test/skills.test.mjs services/platform/test/collaboration-delivery.test.mjs
git commit -m "feat(delivery): require the citation check in the research delivery"
```

---

### Task 8: Local acceptance, image build, and release record

**Files:**
- Modify: `docs/WEB_RELEASE_CHECKLIST.md`
- Modify: `PROGRESS.md`
- Build: `runtime/sandbox/image/Dockerfile` (via the image build context)
- No source change in this task beyond docs; the image/release actions are operational.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified local stack and a recorded cloud release path.

- [ ] **Step 1: Build and verify the worker image**

Build the science/worker image from `runtime/sandbox/image` with the new `pypdf` lock and the new OpenCode binary (CI `sandbox-image.yml` for the attested image; a local-only overlay for local acceptance). Verify:
- `opencode --version` = 1.18.32;
- `grep -ac SCIKEEL_BROKER_PROXY_URL /opt/scikeel/tools/bin/opencode` ≥ 1;
- `python -c "import pypdf"` succeeds;
- the `media`/skills include `literature-review`, `citation-reviewer`, `large-file`, `research-workflow`.

- [ ] **Step 2: Run the local live acceptance**

On the local stack, using the OpenCode runtime (Codex full text is a documented
limitation in this change; no UI/outcome-schema change):
1. Start a fresh session with the literature prompt.
2. Confirm Europe PMC returns hits (200) and PubMed is not required.
3. Download one OA PDF from Europe PMC/PMC with `webfetch savePath`; parse it with `large-file`; cite a page-level claim.
4. Confirm `references.csv` has `pmcid`, `full_text_status`, and `full_text_path`.
5. Confirm `citation_check.json` validates and `citation_check.md` has the claim table.
6. Confirm `research_delivery` passes with all five artifacts and the report's step/check names.
7. Confirm a deliberately uncited reference or missing claim fails delivery.
8. Confirm no PDF bytes appear in the assistant text.

- [ ] **Step 3: Record the release**

Update `docs/WEB_RELEASE_CHECKLIST.md`:
- `runtime/opencode-patches/**`, `runtime/sandbox/**` (including `runtime/sandbox/image/pyproject.toml`/`uv.lock`), and `runtime/skills/core/**` are worker-image inputs.
- The image must contain the new `savePath` binary and `pypdf`.
- The platform source must be redeployed for the citation-check validator and the field-level report errors.
- The local overlay digest is local-only; never use it in production.
- Codex full text/`savePath` remains a future task; do not claim it in this
  change.
- No UI diagnostic field or outcome-schema change; the tool result and
  `search_log.md` carry the failure detail.

Add one `PROGRESS.md` line with the verified local result and the cloud image/platform requirement.

- [ ] **Step 4: Run the broader suites**

Run the affected platform tests and the full frontend suite with the project-local TMPDIR:
`TMPDIR="$PWD/.deploy/test-tmp" pnpm platform:test`
`TMPDIR="$PWD/.deploy/test-tmp" pnpm test`
Expected: all pass; no new failures.

- [ ] **Step 5: Commit the docs**

```bash
git add docs/WEB_RELEASE_CHECKLIST.md PROGRESS.md
git commit -m "docs: record the research flow hardening release"
```

---

## Self-Review

- **Spec coverage:** Europe PMC (Task 1), full text (Tasks 2/5/6), claim support/usage (Tasks 3/4), delivery error (Task 4), criteria/venue/archive (Task 1), image/release (Tasks 5/8), diagnostics (Task 5/7). All spec sections have a task.
- **Type consistency:** `citation_check.json` v1 fields in Task 3 match Task 4's validator; `savePath`/`maxBytes` in Task 5 match Task 2/6; the `full_text_status` values match the CSV schema.
- **Review Focus:** each failure mode has a test in Task 4/5/7 (traversal, oversize, empty claims/uncited, OA fallback, stale image/digest).
- **Proportion:** the plan names files, signatures, tests, and commands; the implementation bodies remain with the implementer.

## Execution Handoff

The user chose **two subagents working side by side, supervising each other,
with the coordinator integrating**. Execution is on a new branch.

### Branch and workspace

- `feat/research-flow-hardening` is created from `feat/examples-entry` (the
  current branch has the literature/citation skills and the examples work).
- This spec and plan are force-added and committed on the new branch (the
  repository gitignores `docs/superpowers/`, but the existing plans/specs are
  tracked; the agents need the documents).
- Both agents work in the feature-branch tree with disjoint file ownership.
  They do not run `git commit`; the coordinator reviews and commits after the
  cross-review. This keeps the two agents side by side without a shared-index
  race.
- Track A uses the verified `.deploy/opencode-source` and local Docker/Bun
  tooling; Track B uses the repo's installed `node_modules`. If the heavy
  runtime build interferes with Track B's tests, the coordinator serializes
  that build; file ownership stays disjoint.
- The coordinator integrates the two tracks on `feat/research-flow-hardening`;
  there are no separate merge branches to reconcile.

### Track split (disjoint file ownership)

**Track A — Runtime and PDF**
- Tasks 5 and 6: `runtime/opencode-patches/**`, `runtime/sandbox/image/**`,
  `runtime/skills/core/large-file/**`.
- Produces the `webfetch savePath` contract, the 32 MiB/120s/`edit` permission
  behavior, the source acceptance test, `large_file_probe.py`/`pdf_text.py`,
  and the `pypdf` image lock.
- Must not edit `literature-review`, `citation-reviewer`, `research-workflow`,
  `services/platform/**`, or `docs/**`.

**Track B — Research contracts and platform**
- Tasks 1–4 and 7: `runtime/skills/core/literature-review/**`,
  `runtime/skills/core/citation-reviewer/**`,
  `runtime/skills/core/research-workflow/**`,
  `services/platform/src/**`, `services/platform/test/**`,
  `runtime/sandbox/collaboration.mjs`.
- Produces Europe PMC, the full-text acquisition contract, the
  `citation_check.json` schema/validator, the delivery field-level errors, and
  the prepare/check integration.
- Must not edit `runtime/opencode-patches/**`, `runtime/sandbox/image/**`, or
  `runtime/skills/core/large-file/**`.

### Frozen interfaces (coordinator-owned)

Both agents write against these before starting:

- `webfetch` input: `{url, format?, timeout?, savePath?}`; `savePath` is
  workspace-relative; output contains the relative path, byte count, and MIME;
  no PDF bytes in model context.
- `full_text_status`: `pdf-text | html-text | scanned | unavailable`.
- `references.csv`: the Task 1 columns, including `pmcid`, `venue_tier`,
  `full_text_status`, `full_text_url`, `full_text_path`.
- `citation_check.json` v1: the Task 3 schema; the platform validator in Task 4
  is the authority for field errors.
- `citation_check.md` is the human view; both artifacts are prepared and
  delivered.

### Cross-review and integration

1. Track A and Track B implement in parallel with TDD and commit.
2. Cross-review: Track A reviews Track B's contract/diff (Europe PMC fields,
   citation JSON, delivery checks); Track B reviews Track A's `savePath`
   contract, permission path, and PDF statuses. Each reports interface
   mismatches to the coordinator; no agent edits the other's files.
3. The coordinator resolves the interfaces, merges both branches, and runs the
   affected tests, the full frontend suite, and the live acceptance.
4. The coordinator builds the worker image, performs the local-only acceptance,
   and records the cloud image/platform redeploy. No local digest is used in
   production.

### Completion gate

- The two tracks are integrated on `feat/research-flow-hardening` and the
  spec/plan tasks are green.
- The live flow downloads one OA PDF (2–3 core papers is a normal set; the
  number is topic/user-driven), parses it, and cites page-level evidence.
- `citation_check.json` fails on an uncited reference/unknown citation and
  passes on the real check.
- The delivery report error names `steps[0].title`/`status`.
- The worker image contains the new binary and `pypdf`; the platform source is
  redeployed from the same commit.
- The latest session's `review.md`/`references.csv`/`citation_check.md` are
  untouched.

Do not modify the latest session's artifacts. Local acceptance uses a
local-only image; cloud verification requires the CI-built image and the
platform redeploy.
