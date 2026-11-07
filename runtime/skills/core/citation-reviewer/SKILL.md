---
name: citation-reviewer
description: Use when the user asks to check, verify, or audit a reference list or citation claims. Resolves DOI/PMID/PMCID/arXiv identifiers through Crossref, OpenAlex, Europe PMC, and arXiv, verifies claim support and citation usage, and writes citation_check.md and citation_check.json when auditing a workspace document.
---

# Citation Reviewer

Verify what each citation points to and whether the source supports the claim
made next to it. You verify traceability, not truth: never state or imply that a
citation is "correct" beyond what the registry and the retrieved text show.

## 1 · Collect references and claims

List every reference in the document. For each, capture the identifier the
document gives (DOI, PMID, PMCID, arXiv ID, or title + year + authors).

Build a claims table for every claim that carries one or more `[n]` citations:

`claim_id | section | claim | citations | evidence_level | support | evidence | evidence_path`

If the document is ambiguous — several reference formats, missing identifiers,
or a claim spanning several sources — ask which entries to audit first. Do not
guess which record a vague citation means.

## 2 · Resolve with `webfetch`

Use the managed `webfetch` tool, one request at a time:

- DOI: `https://api.crossref.org/works/<doi>`
- DOI in OpenAlex: `https://api.openalex.org/works/https://doi.org/<doi>`
- OpenAlex work id: `https://api.openalex.org/works/<id>`
- Europe PMC search by identifier:
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:<id>%20AND%20SRC:MED&format=json&resultType=core`
- arXiv: `https://export.arxiv.org/api/query?id_list=<arxiv_id>`

Europe PMC replaces PubMed E-utilities, which are unreachable from the platform
egress; do not require PubMed.

Compare the document's title, authors, year, venue, and identifiers against the
resolved record. Normalize DOI case and URL prefixes before comparing.

Check retractions through the registry response: OpenAlex `is_retracted`,
Crossref update/relation fields, and Europe PMC publication types or
comment/correction fields. If the response does not expose retraction status,
record that limitation.

## 3 · Verify claim support

For each claim with citations, locate the cited source. Prefer parsed full text
(`papers/text/<id>.txt`), then the abstract or archived raw response. Extract
the sentence or abstract passage you compared and record:

- `evidence_level`: `pdf-text`, `html-text`, `abstract-only`, or `none`. The old
  ambiguous `full-text` value is removed; use it only as prose, never as a JSON
  value.
- `support`: `supported`, `partial`, `unsupported`, or `unverifiable`.
- `evidence`: the quoted sentence or abstract passage.
- `evidence_path`: the workspace-relative file containing that evidence.
- The location (DOI, page or section, or abstract).

Emit `ok` only for `supported`; `warn` for `partial` or `unverifiable`; `error`
for `unsupported`. Never say a citation is "correct". Abstract-only support does
not establish a detailed claim, and evidence_level `none` means the source could
not be read.

## 4 · Verify citation usage

- Every `[n]` in `review.md` maps to a row in `references.csv`.
- Every row with `screening=include` is cited at least once in `review.md`;
  excluded/maybe rows are not required to be cited.
- Uncited included references are `warn` in the human report. For delivery,
  `usage.uncited` must be empty for included references: cite them or remove
  them. Uncited excluded/maybe rows may be listed in `usage.uncited` without
  failing.
- Citations to missing rows are `error`; `usage.unknown` must be empty.
- Every reference must appear in `usage.cited` or `usage.uncited`.

## 5 · Write the artifacts

When auditing a workspace document, write both files at the workspace root.

`citation_check.md` — the human-readable metadata and claim tables, including
the claim-support table and the citation-usage result.

`citation_check.json` — the machine-readable v1 evidence:

```json
{
  "version": 1,
  "references": [
    {"id": "1", "doi": "10.…", "metadata": "resolved", "retracted": false,
     "screening": "include", "full_text_status": "pdf-text",
     "full_text_path": "papers/text/1.txt"}
  ],
  "claims": [
    {"claim_id": "c1", "section": "3", "claim": "…", "citations": ["1"],
     "evidence_level": "pdf-text", "support": "supported",
     "evidence": "quoted sentence", "evidence_path": "papers/text/1.txt"}
  ],
  "usage": {"cited": ["1"], "uncited": [], "unknown": []},
  "summary": {"claims": 1, "supported": 1, "partial": 0, "unsupported": 0, "unverifiable": 0}
}
```

Rules the platform enforces structurally when the workspace document is a
delivery artifact:

- `version` is `1`; `references`, `claims`, `usage`, and `summary` are present.
- At least one claim; each claim has `claim_id`, `section`, `claim`,
  `citations`, `evidence_level`, `support`, `evidence`, and `evidence_path`.
- Every claim citation maps to a reference id.
- Every reference appears in `usage.cited` or `usage.uncited`; `usage.unknown`
  is empty; no included reference is in `usage.uncited`.
- For evidence_level other than `none`, `evidence_path` is a workspace-relative
  file that exists. For `full_text_status: html-text`, `full_text_path` is the
  saved HTML/XML or a derived text file that exists; omit it for `scanned` or
  `unavailable` unless a real extracted text file exists.
- The platform checks structure and path existence only; your support verdicts
  remain agent-reported judgments.

Do not use a fabricated quotation, page, abstract, or full-text claim to fill
the table.

## 6 · Output contract

Write the artifacts first, then end the reply with exactly one fenced block (the
app renders it as reviewer cards; keep it as the LAST thing in the message):

```review
{"findings":[{"level":"warn","check":"citation","title":"Year mismatch","evidence":"10.1234/example cites 2021; Crossref issued 2019"}],"note":"Citation review — verified identifiers, metadata, and claim support. Absence of findings is not a guarantee of correctness."}
```

- `level`: `error` | `warn` | `ok`
- `check`: `"citation"`
- `title`: a short diagnosis
- `evidence`: the exact identifier, the document's claim, and the observed
  registry or full-text value

## 7 · Boundaries

- Defer report numbers, untraceable statistics, and figure ↔ code checks to the
  `traceability-review` skill; do not duplicate them here.
- If a source cannot be resolved, report it as unresolved. Do not guess an
  identifier, metadata, or quotation.
- Never claim a citation is correct; state what resolved and what was compared.
