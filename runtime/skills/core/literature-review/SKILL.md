---
name: literature-review
description: Use when the user asks for a literature review, survey, or structured search of the scholarly literature. Pre-specifies criteria, searches Europe PMC, OpenAlex, Crossref, Semantic Scholar, and arXiv through webfetch, archives raw responses, downloads open-access full text, and never invents papers or citations.
---

# Literature Review

Build a reproducible review from real scholarly records. Search public sources,
archive what you retrieved, and cite only records you actually retrieved. Never
invent papers, DOIs, PMIDs, PMCIDs, arXiv IDs, quotations, or findings.

## 1 · Pre-specify the search contract

Before the first query, write this contract at the top of `search_log.md`:

- Topic and research question.
- Population, method, and field.
- Date range and language limits.
- Publication types (for example journal articles, preprints, or reviews).
- Inclusion and exclusion criteria.
- Venue preference: prefer top venues but keep field-core venues. Record each
  record's `venue_tier` as `top`, `field-core`, or `other`, and explain any
  exception. This is a preference, never a hard exclusion filter.
- Core full-text set: there is no fixed 5–10 default. Usually two or three
  papers support a narrow review; the user request or field conventions can ask
  for a different number. Record the chosen set and why in `search_log.md`.

After screening, use the `question` tool when the core set or a paywalled
priority is ambiguous. Do not silently choose abstract-only evidence for
everything.

## 2 · Search with `webfetch`

Use the managed `webfetch` tool for every request. Do not use shell network
commands unless the user explicitly approves them. URL-encode the query and run
one request at a time.

- Europe PMC (the MEDLINE source):
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<encoded>&format=json&pageSize=25&resultType=core`
  Use `query=TITLE_ABS:"..." AND ...`; `sort=CITED desc` or
  `sort=P_PDATE_D desc` where useful. Read `pmid`, `pmcid`, `doi`, `title`,
  `authorString`, `journalTitle`, `pubYear`, `abstractText`, `isOpenAccess`,
  `hasPDF`, `fullTextUrlList.fullTextUrl[]`, and `fullTextIdList`.
- OpenAlex: `https://api.openalex.org/works?search=<query>&per-page=25`
- Crossref: `https://api.crossref.org/works?query=<query>&rows=25`
- Semantic Scholar:
  `https://api.semanticscholar.org/graph/v1/paper/search?query=<encoded>&limit=25&fields=title,authors,year,venue,externalIds,abstract,openAccessPdf,isOpenAccess`
- arXiv: `https://export.arxiv.org/api/query?search_query=all:<query>&start=0&max_results=25`

PubMed E-utilities are unreachable from the platform egress. Do not use them or
keep a dead PubMed-only step. If Europe PMC
fails, record the failure and the fallback in `search_log.md`, continue with the
remaining sources, and tell the user which source failed. Do not replace a
failed search with model memory.

Add filters through the API's own parameters (for example OpenAlex
`filter=from_publication_date:2015-01-01`). Keep the number of queries
proportionate to the question; ask before running a large batch.

## 3 · Record the search and raw evidence

Write `search_log.md` as you go. One entry per request:

- UTC timestamp, source name, exact URL, query, filters, HTTP result.
- Number of records returned and how many were screened in.
- Any failure, rate limit, or empty result, with the URL and host.

Archive the raw response from each request under
`search/raw/<timestamp>-<source>.json`: use `webfetch` with
`savePath: search/raw/<timestamp>-<source>.json` so the raw bytes and the
screening text share one request. Keep the files after the run; do not delete
`search/raw/`, `papers/`, or `papers/text/`. For a large response use the
`large-file` skill.

Write `references.csv` with one row per record:

```csv
id,title,authors,year,venue,venue_tier,doi,pmid,pmcid,arxiv_id,source_url,abstract_status,full_text_status,full_text_url,full_text_path,screening
```

- `abstract_status`: `abstract-only` or `none`. Never call an abstract
  `full-text`.
- `full_text_status`: `pdf-text`, `html-text`, `scanned`, or `unavailable`.
- `venue_tier`: `top`, `field-core`, or `other`.
- `screening`: `include`, `exclude`, or `maybe`, with the reason in the review.

Deduplicate by DOI first, then by normalized title and year.

## 4 · Acquire open-access full text

After screening, try open access in this order:

1. Europe PMC `fullTextUrlList` (`availabilityCode: OA`; `documentStyle` `pdf`
   or `html`), or the XML fallback
   `https://www.ebi.ac.uk/europepmc/webservices/rest/{source}/{id}/fullTextXML`.
   Save an HTML/XML copy with `webfetch` `savePath: papers/<safe-id>.html` (or
   `.xml`) before using it as evidence; the saved raw file is the
   `full_text_path` for `html-text`.
2. OpenAlex `best_oa_location.pdf_url` or `open_access.oa_url`.
3. Semantic Scholar `openAccessPdf`.
4. arXiv PDF for arXiv records.

Unpaywall is optional only when the user supplies a real contact email; never
fabricate one. Do not include it in the default order.

For each paper in the core set:

- Download with `webfetch` `savePath: papers/<safe-id>.pdf` and `timeout: 120`.
  A PDF download returns a path pointer, not PDF bytes. The `savePath` download
  mode exists only in the OpenCode runtime; in Codex, ask the user to upload the
  PDF (documented limitation).
- Parse the PDF with the `large-file` skill's PDF helper into
  `papers/text/<safe-id>.txt`; read only the pages or sections a claim needs.
- For an HTML or XML copy, save it with `webfetch`
  `savePath: papers/<safe-id>.html` or `papers/<safe-id>.xml`. Record that exact
  saved path as `full_text_path` with `full_text_status: html-text`. A derived
  text file such as `papers/text/<safe-id>.txt` may be recorded instead only
  after it actually exists.
- Record `full_text_status`, `full_text_url`, `full_text_path`, and `pmcid` in
  `references.csv`. `full_text_path` must be a file that the flow actually
  wrote; leave it empty for `scanned` or `unavailable` unless a real extracted
  text file exists.
- If no open-access copy exists, set `full_text_status` to `unavailable` and use
  the abstract. When the user needs that paper, use the `question` tool to ask
  whether to proceed with abstract-only evidence or to upload the PDF.
- A PDF without a text layer is `scanned`; do not OCR or invent text.
- Never label abstract-only support as `full-text`. Use `pdf-text` or
  `html-text` only after parsed text exists.

## 5 · Screen and synthesize

- Screen by title and abstract against the pre-specified criteria.
- Group included records by theme, method, population, or finding.
- For each theme: what the literature agrees on, where it conflicts, and what
  it has not addressed.
- Every claim in `review.md` cites a record from `references.csv`.
- Distinguish `pdf-text`, `html-text`, `abstract-only`, and `none` evidence. Do
  not present an abstract-only finding as confirmed.
- Every `screening=include` record must be cited at least once in `review.md`;
  excluded/maybe records are not required to be cited.
- State the search limitations: databases, date range, query terms, and any
  records that could not be accessed.

For large result dumps use the `large-file` skill. For a taxonomy or trend
figure use the `publication-figures` skill.

## 6 · Require the citation check

After the draft, invoke the `citation-reviewer` skill over `review.md`,
`references.csv`, and the acquired full text. It must verify metadata and
retraction, per-claim claim support (supported, partial, unsupported, or
unverifiable), and citation usage. It writes both `citation_check.md` (the human
claim table) and `citation_check.json` (v1 evidence with references, claims,
usage, and summary).

Delivery requires `usage.uncited` and `usage.unknown` to be empty for included
references: cite or remove every uncited `screening=include` record. Excluded or
maybe records need not be cited.

The `evidence_path` in `citation_check.json` must be a file that exists: use
`papers/text/<safe-id>.txt` for `pdf-text`, the saved
`papers/<safe-id>.html` or `.xml` (or a derived text file that exists) for
`html-text`, and the archived abstract or raw response for `abstract-only`.
Never record a path that the flow did not write.

## 7 · Failures and fallback

If an API is unreachable, returns an error, rate-limits you, or returns no
usable records:

1. Record the exact failure and URL in `search_log.md`.
2. Tell the user which source failed and what is still available.
3. Ask for a staged corpus of PDFs or abstracts to review offline.

Do not replace a failed search with model memory, and do not invent a record to
fill a gap. A review with fewer, verified sources is acceptable; a fabricated
source is not.

## 8 · Deliverables

- `review.md` — the synthesized review with inline citation ids.
- `references.csv` — the screened record table with the full-text columns.
- `search_log.md` — the pre-specified contract, every query, URL, timestamp,
  result count, failure, and the chosen core full-text set.
- `citation_check.md` — the human-readable metadata and claim-support table.
- `citation_check.json` — the machine-readable v1 citation check.

Call `research_delivery` with action `prepare` and all five deliverables, run
the citation check, record the check titled "citation metadata + claim support"
with evidence `citation_check.json`, then verify. State plainly that the review
covers only the sources actually searched and retrieved.
