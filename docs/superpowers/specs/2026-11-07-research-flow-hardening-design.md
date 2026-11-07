# Research Flow Hardening — Design

**Date:** 2026-11-07
**Status:** Draft for review. No implementation starts until this document is approved.

## Why

The latest live literature-review session (`ses_e4a1148a...`, 2026-11-07 20:14)
completed and passed delivery verification, but its process had four defects
that will recur:

1. **PubMed was unreachable** from the Docker platform egress
   (`eutils.ncbi.nlm.nih.gov` → `ECONNRESET`), while Europe PMC returned 200
   from the same container. The session had no MEDLINE fallback.
2. **No full text was downloaded.** The review is abstract-only; 27 papers were
   screened, but no open-access PDF was fetched or parsed. The worker image has
   no PDF parser (`pypdf`, `fitz`, `pdfplumber`, `pdftotext` are absent).
3. **Citation checking stopped at metadata.** `citation_check.md` resolved
   DOI/title/year/retraction for all 27 records, but did not test whether each
   citation supports the claim beside it. The `citation-reviewer` skill already
   asks for claim support; the workflow did not require the output.
4. **The delivery report schema error was opaque.** The first report used
   `"step"` instead of `"title"`; the platform returned
   `Research report steps[0] is invalid` / `missing_progress`. The agent spent
   roughly fifteen tool calls inspecting binaries and the skill before fixing it.

The user's decisions:

- Ignore the artifact-level bugs in that session (e.g. uncited references
  `[24]`/`[26]`); fix the process so they do not recur.
- Implement **open-access PDF download + parsing** (option A), including the
  required runtime and worker-image rebuild.
- Use **Europe PMC** in place of the unreachable PubMed path if it works; it
  does (200 from the platform container). If it later becomes unreachable and
  the proxy cannot help, drop that source rather than keep a dead path.
- Adopt the **recommended process scope**: claim support, delivery errors,
  full text, Europe PMC, citation-usage validation, pre-specified screening
  criteria, and raw-response archiving.
- Treat top venues as a **preference**, not a hard filter.
- Use the app's `question` tool to let the user decide which core papers to
  download when the choice is not obvious.

### Coordinator decisions after the builder check

- **Runtime scope:** OpenCode only. The Codex native tool surface
  (`runtime/sandbox/native-tools.mjs`, `native-network.mjs`) does not accept
  `savePath`; extending it is a separate future task. Document the limitation.
- **Unpaywall:** not used by default. It is a free DOI-to-legal-OA-copy API that
  needs a contact email; using a fabricated address violates the no-fabrication
  rule. Add it only if the user supplies a real email. The default discovery
  order is Europe PMC → OpenAlex → Semantic Scholar → arXiv.
- **Diagnostics:** the tool result and `search_log.md` carry the URL/host and
  failure; do not add a UI field or change the outcome schema.
- **`savePath` and raw archive:** for a PDF, return a pointer only. For a
  text/JSON response, save the raw bytes and return a bounded text preview, so
  the raw archive and screening share one request.
- **Citation usage:** only `screening=include` rows in `references.csv` must be
  cited; excluded/maybe rows are not required. Uncited *included* references
  fail delivery.
- **Citation artifacts:** `citation-reviewer` writes `citation_check.md` and
  `citation_check.json` when it audits a workspace document; the `review` block
  remains the last thing in the reply.
- **Report steps:** an invalid `status` is rejected with a field-level error,
  not silently coerced to `pending`.
- **Reference status:** `abstract_status` is `abstract-only` or `none`;
  `full_text_status` is `pdf-text`, `html-text`, `scanned`, or `unavailable`.
  The old ambiguous `full-text` value is removed.

## Goals

1. MEDLINE coverage via Europe PMC, with no dependency on `eutils.ncbi.nlm.nih.gov`.
2. A reproducible full-text path for core open-access papers:
   discover OA copy → download PDF through the managed network → parse text →
   put bounded text into the agent's context → use it for claim support.
3. A citation check that verifies, per claim: identifier/metadata, retraction,
   **claim support**, and **citation usage** (every reference cited, every
   citation mapped).
4. Delivery report validation that names the invalid field and shows the
   expected shape, so a correct report is written on the first attempt.
5. Pre-specified inclusion/exclusion criteria, a recorded venue preference, and
   preserved raw search evidence.
6. No regression to the managed network, permissions, workspace isolation, or
   the 3.3 GiB cloud-host limits.

## Non-goals

- Do not repair the 2026-11-07 session's review or reference list.
- Do not implement a hard top-venue filter.
- Do not add a new scientific UI or a new review workflow.
- Do not bypass managed networking, sandbox permissions, or the delivery gate.
- Do not promise full text for paywalled papers. If no open-access copy exists,
  mark it unavailable and ask the user to provide the PDF if they need it.
- Do not change desktop-only behavior; this is Web-gateway work.
- Do not extend the Codex native tool surface with `savePath`/PDF download in
  this change; Codex full text is a documented future task.
- Do not add a UI diagnostic field or change the tool-outcome schema; the tool
  result and search log carry the failure detail.

## Anti-goals

- Fabricating a quotation, page, abstract, or full-text claim.
- Reporting `full-text` support when only an abstract was read.
- Silently replacing a failed source with model memory.
- Letting a downloaded PDF or raw response escape the session workspace.
- Reusing the local, unattested worker-image digest on the cloud host.
- Making delivery pass by weakening checks or marking a failed source complete.

## Constraints

- OpenCode 1.18.32, Bun 1.3.14, Tauri/Web gateway, Tailwind/Radix UI where UI
  changes are unavoidable (none planned here).
- All Web file/network work goes through the session workspace and the managed
  network. The worker shell has no direct external network.
- `runtime/skills/core/**`, `runtime/sandbox/**`, and
  `runtime/opencode-patches/**` are worker-image inputs. A change here requires
  a source-built worker image and a platform-source redeploy.
- The cloud host has 3.3 GiB RAM; builds/tests stay bounded and use the project
  task runners.
- New PDF writes are workspace effects and must respect the existing permission
  model.
- The worker image is built from `runtime/sandbox/image/{Dockerfile,
  pyproject.toml,uv.lock}`; the OpenCode binary is built from the pinned
  upstream commit plus `runtime/opencode-patches/*.patch`.
- The local overlay image is for local verification only; its digest is never
  used in production.

## Design

### 1. Sources: Europe PMC replaces the PubMed-only path

`literature-review` and `citation-reviewer` change their MEDLINE source from
PubMed E-utilities to Europe PMC:

- Search:
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<encoded>&format=json&pageSize=25&resultType=core`
- Query syntax: `query=TITLE_ABS:"..." AND ...`; `sort=CITED desc` or
  `sort=P_PDATE_D desc` where useful.
- Fields used: `pmid`, `pmcid`, `doi`, `title`, `authorString`,
  `journalTitle`, `pubYear`, `abstractText`, `isOpenAccess`, `hasPDF`,
  `fullTextUrlList.fullTextUrl[]` (`availabilityCode: OA`, `documentStyle:
  pdf|html`), `fullTextIdList`.
- Full text: the OA PDF URL from `fullTextUrlList`; XML fallback at
  `https://www.ebi.ac.uk/europepmc/webservices/rest/{source}/{id}/fullTextXML`.
- If Europe PMC fails, record the failure, fall back to OpenAlex/Crossref, and
  tell the user. Do not keep a PubMed-only step that is known to fail.
- `references.csv` gains `pmcid`; `search_log.md` names Europe PMC.

The change is skill content, not platform code. It is still an image input.

### 2. Full-text acquisition

After screening, the agent selects the smallest set of core papers needed to
support the review. There is no fixed 5–10 default: two or three papers can be
enough for a narrow topic, and the user or the field's conventions can request
a different number. Record the chosen set and why in `search_log.md`; use the
`question` tool when the choice is ambiguous. It attempts open-access full text
in this order:

1. Europe PMC `fullTextUrlList` OA PDF/HTML.
2. OpenAlex `best_oa_location.pdf_url` / `open_access.oa_url`.
3. Semantic Scholar `openAccessPdf`.
4. arXiv PDF for arXiv records.

Unpaywall is optional only when the user supplies a real contact email; never
substitute a fabricated address. Do not include it in the default order.

For each paper:

- Download with `webfetch` plus the new `savePath` argument into
  `papers/<safe-id>.pdf`.
- Parse to `papers/text/<safe-id>.txt` using the `large-file` PDF helper.
- Record `full_text_status` (`pdf-text`, `html-text`, `scanned`,
  `unavailable`), `full_text_url`, `full_text_path`, and `pmcid` in
  `references.csv`.
- If no open-access copy exists, mark `unavailable` and use the abstract. When
  the user needs the paper, ask through the `question` tool whether to proceed
  with abstract-only evidence or to upload the PDF.
- Use the `question` tool after screening when the core set or paywalled
  priorities are ambiguous; the user decides.

The review must distinguish `pdf-text`, `html-text`, `abstract-only`, and
`none` evidence. It must never call abstract-only support `full-text`.

### 3. PDF download: `webfetch` `savePath`

The existing `webfetch` tool is the managed-network client. It gains an optional
`savePath` argument:

```ts
savePath: Schema.optional(Schema.String).annotate({
  description: "Save the response bytes to this workspace-relative path instead of returning text. Use for PDF downloads."
})
```

Behavior:

- `savePath` must be relative, non-empty, ≤512 bytes, with no `..`, no absolute
  path, no NUL/control characters. Resolve against the session instance
  directory and reject anything that resolves outside it (including symlinked
  parents). Create parent directories.
- Ask the normal `webfetch` permission for the URL and an `edit` permission for
  the save path; the user can reject either.
- The download path uses a 32 MiB cap (matching the egress broker's
  `maxBytes`), not the current 5 MiB text cap. The tool checks
  `content-length` and the buffered byte count. `timeout` remains capped at 120
  seconds; the skill uses 120 for PDFs.
- For a PDF, the tool returns a short pointer: relative path, byte count, MIME
  type, and URL. It does not return PDF bytes to the model.
- For a text/JSON response, the tool saves the raw bytes and returns a bounded
  text preview (for example 48 KiB; the platform truncates tool output at
  50 KiB), so the raw archive and screening share one request. The raw file
  remains at `savePath`; the preview is not a second fetch.
- The managed client gets a `maxBytes` option so the webfetch path can buffer
  up to 32 MiB while websearch stays at 2 MiB. The egress broker already caps at
  32 MiB.
- The platform's existing `/network` authorize path needs no new endpoint: it
  already authorizes the URL from `part.state.input.url`; `savePath` is an
  additional tool input, not a new destination. Add an acceptance assertion
  that a webfetch part carrying `savePath` still authorizes and completes.
- The file write publishes the normal file-system/watcher events so the
  workspace sees `papers/...`. The bytes are not attached as an image.
- Path traversal, absolute paths, oversized responses, non-200 responses, and
  permission rejection are tested.

### 4. PDF parsing: `large-file` + pinned `pypdf`

The `large-file` skill is the shared entry point for reading files too large for
context. It gains PDF support:

- `large_file_probe.py` detects `.pdf`; with `pypdf` it reports page count,
  document metadata, per-page character counts, and a first-page sample. If
  `pypdf` is absent, it returns a pointer with an install hint, not raw bytes.
- A companion `pdf_text.py` extracts a bounded page range to stdout or to
  `papers/text/<id>.txt`; the agent reads only the sections it needs (default
  max 2 MiB of extracted text).
- `pypdf` is added to `runtime/sandbox/image/pyproject.toml` and the lockfile
  regenerated in the same CI step that currently runs `uv lock --locked`. The
  image build context is `runtime/sandbox/image/`; the local overlay image must
  also contain `pypdf`.
- Scanned/image-only PDFs without a text layer are reported as `scanned`, not
  silently treated as full text. OCR is out of scope.
- The parser is read-only; it never modifies the PDF.

### 5. Claim support and citation usage

`citation-reviewer` keeps the metadata/retraction check and adds a required
claim-support pass:

For each claim in `review.md` that carries one or more citations:

- Locate the cited source; prefer parsed full text, then abstract.
- Extract the sentence or abstract passage compared.
- Record one of `supported`, `partial`, `unsupported`, `unverifiable`, plus
  `pdf-text` / `html-text` / `abstract-only` / `none` evidence level.
- Record the location (DOI, page/section, or abstract).
- Emit a `warn` for `partial`/`unverifiable`, an `error` for `unsupported`, and
  `ok` only for `supported`. Never say a citation is "correct".

When auditing a workspace document, `citation-reviewer` writes two artifacts
and still ends with exactly one `review` block:

- `citation_check.md` — the human-readable metadata and claim tables:
  `claim_id | section | claim | citations | evidence_level | support | evidence`
- `citation_check.json` — the machine-readable v1 evidence:

```json
{
  "version": 1,
  "references": [
    {"id": "1", "doi": "10.…", "metadata": "resolved", "retracted": false,
     "full_text_status": "pdf-text", "full_text_path": "papers/text/1.txt"}
  ],
  "claims": [
    {"id": "c1", "section": "3", "claim": "…", "citations": ["1", "2"],
     "evidence_level": "pdf-text|html-text|abstract-only|none",
     "support": "supported|partial|unsupported|unverifiable",
     "evidence": "quoted sentence or abstract passage",
     "evidence_path": "papers/text/1.txt"}
  ],
  "usage": {"cited": ["1"], "uncited": ["24"], "unknown": []},
  "summary": {"claims": 12, "supported": 9, "partial": 2, "unsupported": 0, "unverifiable": 1}
}
```

Citation-usage validation is structural:

- Every `[n]` in `review.md` maps to a row in `references.csv`.
- Every row with `screening=include` is cited at least once in `review.md`;
  excluded/maybe rows are not required to be cited.
- Uncited included references are `warn` in the human report; for delivery,
  `usage.uncited` must be empty for included references (cite or remove them).
  This is the process fix for the `[24]`/`[26]` class of defect; it does not
  repair the existing session's artifacts.
- Citations to missing rows are `error`; `usage.unknown` must be empty.

`literature-review` calls `citation-reviewer` after the draft and requires both
artifacts. The `research_delivery` prepare includes `review.md`,
`references.csv`, `search_log.md`, `citation_check.md`, and
`citation_check.json`. The delivery check "citation metadata + claim support"
uses `citation_check.json`; the platform validates its structure and referenced
paths (not scientific truth) and fails the delivery if the file is missing or
invalid. The scientific judgments remain agent-reported and must be described
as such.

### 6. Delivery report schema and error

`services/platform/src/research-tasks.mjs` currently catches any invalid step
and returns `Research report steps[<n>] is invalid`. It changes to a field-level
message, for example:

```text
Research report steps[0] must be an object with a non-empty "title" and a
valid "status" (pending, running, completed, failed); found keys: step, note.
```

An invalid `status` is rejected, not coerced to `pending`; the test suite
covers a `"done"`/`"complete"` status and asserts the field-level error.

`research_delivery`'s tool description (and the `research-workflow` skill) shows
the minimal report template with `title`/`status`, so the model does not need to
reverse-engineer the binary. A delivery test writes a report with `"step"` and
asserts the field-level error; a repaired report with `"title"` passes.

The report steps use `completed` only for the requested output/check that
succeeded. A source that failed and was replaced (e.g. PubMed replaced by
Europe PMC) is recorded in `limitations`, not marked as a successful PubMed
step. `citation_check.md` and `citation_check.json` are included in `prepare`
deliverables.

The delivery verifier also validates `citation_check.json` structurally, in
`services/platform/src/research-tasks.mjs` (or the delivery path in
`collaboration.mjs` if that is the narrower seam):

- The file must exist, be valid JSON, and have `version: 1`.
- `references`, `claims`, and `usage` must be arrays/objects with the fields in
  §5; at least one claim is required.
- Every claim citation must map to a reference; every reference must appear in
  `usage.cited` or `usage.uncited`; `usage.unknown` and `usage.uncited` must be
  empty for delivery to pass.
- For a claim or reference with `evidence_level` other than `none`, the
  `evidence_path` must be a workspace-relative file that exists. The platform
  verifies structure and path existence only; it does not judge the truth of
  the support verdict.

A field-level error names the bad path, for example:

```text
citation_check.json claims[3].support must be one of
supported, partial, unsupported, unverifiable
```

Tests cover a valid check, a missing `title` step, a missing claim, an uncited
reference, an unknown citation, and a missing evidence path.

### 7. Pre-specified criteria, venue preference, and raw archive

`literature-review` writes the inclusion/exclusion criteria and venue preference
**before** the first query, in `search_log.md`:

- Topic, population/method, date range, language, publication types.
- A venue preference: prefer top venues, but keep field-core venues; record a
  `venue_tier` (`top`, `field-core`, `other`) in `references.csv` and explain
  exceptions. No hard exclusion.
- Raw evidence: `search/raw/<timestamp>-<source>.json` for API responses,
  `papers/` for PDFs, `papers/text/` for extracted text. Keep the files; do not
  `rm -rf work/` after use. Apply size caps and use `large-file` for large
  responses.

### 8. Image and release

- Runtime patch: update `runtime/opencode-patches/network.patch` and
  `runtime/opencode-patches/managed-network.ts` for `savePath` and the 32 MiB
  download bound; update `network.lock.json` hashes.
- Skills: update `literature-review`, `citation-reviewer`, `large-file`,
  `research-workflow`.
- Image: add `pypdf` to `runtime/sandbox/image/pyproject.toml` and regenerate
  `uv.lock`; the CI image build includes the new patch and skills.
- Platform: `research-tasks.mjs` error change; tests.
- Release: build the worker image via `.github/workflows/sandbox-image.yml`
  (`workflow_dispatch`), install it, set the digest, restart through
  `pnpm live:maintenance`, and redeploy the platform source. The local overlay
  image may be used for local acceptance only; never in production.
- Update `docs/WEB_RELEASE_CHECKLIST.md` with the new image inputs (pypdf,
  network patch, full-text behavior).

### 9. Diagnostics

- `webfetch` transport failures include the URL/host in the tool result and
  `search_log.md`; the UI's generic "tool failed" card stays. Do not add a UI
  field or change the outcome schema; do not expose private upstream bodies.
- The search log records source failure and the chosen fallback.
- The acceptance test reports the downloaded path, byte count, extracted page
  count, and the claim-support counts.

## Acceptance

### Automated

- `network-native.acceptance.mjs`:
  - A webfetch with `savePath` writes the exact PDF bytes to the workspace and
    returns a path; no PDF bytes in the tool output.
  - `../`, absolute paths, symlinked parents, >32 MiB, and permission rejection
    fail safely.
  - A webfetch with `savePath` still obtains `/network` authorization and
    completes through the proxy.
- Platform delivery test: an invalid `"step"` report yields a field-level
  message; a repaired `"title"` report passes.
- Platform citation-check test: a valid `citation_check.json` passes; a missing
  claim, an uncited reference, an unknown citation, and a missing evidence path
  fail with field-level errors.
- Skill tests: `literature-review`, `citation-reviewer`, `large-file`, and
  `research-workflow` contain the Europe PMC, PDF, claim-support, citation-usage,
  pre-specified-criteria, and report-template markers.
- `citation_check.json` schema test: every claim has an evidence level and a
  support verdict; every reference maps to a cited/uncited entry.
- PDF helper test: a small generated PDF yields page count, sample, and
  bounded text.

### Live local

- A fresh session searches Europe PMC for the user's topic (e.g. taste
  prediction), downloads one OA PDF from Europe PMC/PMC, parses it, and cites a
  page-level claim.
- `citation_check.md` contains the claim table and citation-usage result, and
  `citation_check.json` validates with no uncited or unknown citations.
- `research_delivery` passes with `review.md`, `references.csv`,
  `search_log.md`, `citation_check.md`, and `citation_check.json`; the report's
  step/check names match the actual flow.
- PubMed is not required; if Europe PMC fails, the session records the failure
  and uses the remaining sources.

### Cloud

- The CI-built worker image contains the new OpenCode binary (`savePath`), the
  new skills, and `pypdf`.
- The platform source is redeployed from the same commit.
- The same live checks pass; the local digest is not reused.

## Risks and trade-offs

- **Runtime/image cost.** PDF download requires an OpenCode source patch,
  binary rebuild, and worker-image rebuild in CI and locally. This is the
  expensive dependency the user accepted.
- **PDF variability.** Scanned PDFs, malformed PDFs, and publisher blocks can
  fail; the flow marks them and does not fabricate text.
- **Paywalls.** Only OA copies are downloaded. The user can provide PDFs for
  paywalled papers; the `question` tool handles the choice.
- **Europe PMC dependency.** It works now; if it later fails, the flow degrades
  to OpenAlex/Crossref and records the limitation.
- **Citation enforcement.** The platform cannot verify scientific claim support;
  the claim table makes the work visible and reviewable, not magically correct.
- **Workspace growth.** PDFs and raw JSON add files to the session workspace and
  its local git; a bounded core set and size caps limit this.
- **Security.** `savePath` is a new write path; path traversal, symlinks,
  permissions, and size limits are tested.

## Builder's calls (not user decisions)

- Exact `pypdf` version and pinned lock entry.
- Default PDF page/text cap (proposed 2 MiB extracted text); the core set is
  not a fixed 5–10 — usually 2–3, adaptive to the topic and user request.
- `venue_tier` values and the top-venue heuristic for this field.
- Whether to mirror `savePath` in the legacy `packages/core` webfetch tool or
  only the OpenCode tool used by the worker.
- Whether to add a distinct `invalid_report` analytics code or keep
  `missing_progress` with a field-level message.
- Raw archive size caps and whether to add `search/raw/` to the workspace
  `.gitignore`.
