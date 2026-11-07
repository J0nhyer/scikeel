---
name: citation-reviewer
description: Use when the user asks to check, verify, or audit a reference list or citation claims. Resolves DOI/PMID/arXiv identifiers through Crossref, OpenAlex, PubMed, and arXiv, flags mismatches and retractions, and emits the app's structured citation findings.
---

# Citation Reviewer

Verify what each citation points to and whether the source supports the claim
made next to it. You verify traceability, not truth: never state or imply that a
citation is "correct" beyond what the registry and the retrieved text show.

## 1 · Collect the references

List every reference in the document. For each, capture the identifier the
document gives (DOI, PMID, arXiv ID, or title + year + authors) and the claim it
supports.

If the document is ambiguous — several reference formats, missing identifiers,
or a claim spanning several sources — ask which entries to audit first. Do not
guess which record a vague citation means.

## 2 · Resolve with `webfetch`

Use the managed `webfetch` tool, one request at a time:

- DOI: `https://api.crossref.org/works/<doi>`
- DOI in OpenAlex: `https://api.openalex.org/works/https://doi.org/<doi>`
- OpenAlex work id: `https://api.openalex.org/works/<id>`
- PMID: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<pmid>&retmode=json`
- arXiv: `https://export.arxiv.org/api/query?id_list=<arxiv_id>`

Compare the document's title, authors, year, venue, and identifiers against the
resolved record. Normalize DOI case and URL prefixes before comparing.

## 3 · Classify findings

Emit one finding per issue:

- `error` — the identifier does not resolve, resolves to a different work, or
  the record is retracted.
- `warn` — metadata mismatch (title, authors, year, or venue), duplicate
  references, unresolvable title-only citations, or a claim the abstract/full
  text does not support.
- `warn` — the network is unavailable and the citation could not be verified.
  Say "could not verify (offline)" rather than skipping silently.
- `ok` — the record resolved and the metadata is consistent. Use `ok` sparingly
  and never phrase it as "the citation is correct".

Check retractions through the registry response: OpenAlex `is_retracted`,
Crossref update/relation fields, and PubMed publication types. If the response
does not expose retraction status, record that limitation.

For claim support, quote the sentence or abstract passage you compared. Mark
`full-text` or `abstract-only` support explicitly; abstract-only support does
not establish a detailed claim.

## 4 · Output contract

End the reply with exactly one fenced block (the app renders it as reviewer
cards; keep it as the LAST thing in the message):

```review
{"findings":[{"level":"warn","check":"citation","title":"Year mismatch","evidence":"10.1234/example cites 2021; Crossref issued 2019"}],"note":"Citation review — verified identifiers and metadata. Absence of findings is not a guarantee of correctness."}
```

- `level`: `error` | `warn` | `ok`
- `check`: `"citation"`
- `title`: a short diagnosis
- `evidence`: the exact identifier, the document's claim, and the observed
  registry value

## 5 · Boundaries

- Defer report numbers, untraceable statistics, and figure ↔ code checks to the
  `traceability-review` skill; do not duplicate them here.
- If a source cannot be resolved, report it as unresolved. Do not guess an
  identifier, metadata, or quotation.
- Never claim a citation is correct; state what resolved and what was compared.
