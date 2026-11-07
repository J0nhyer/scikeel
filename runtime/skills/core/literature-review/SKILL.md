---
name: literature-review
description: Use when the user asks for a literature review, survey, or structured search of the scholarly literature. Searches public scholarly APIs through webfetch, records queries and sources, synthesizes themes and gaps, and never invents papers or citations.
---

# Literature Review

Build a reproducible review from real scholarly records. Search public sources,
record what you searched, and cite only records you actually retrieved. Never
invent papers, DOIs, PMIDs, arXiv IDs, quotations, or findings.

## 1 · Clarify before searching

Ask for anything missing:

- Topic and research question.
- Scope: population, method, field, and inclusion/exclusion criteria.
- Date range and language limits.
- Intended use: course paper, thesis proposal, or submission.
- Whether the user already has PDFs or a reference list to include.

If the topic is broad enough to produce hundreds of hits, propose a narrower
question and wait for confirmation before running many queries.

## 2 · Search with `webfetch`

Use the managed `webfetch` tool for every request. Do not use shell network
commands unless the user explicitly approves them. URL-encode the query and run
one request at a time.

- OpenAlex: `https://api.openalex.org/works?search=<query>&per-page=25`
- Crossref: `https://api.crossref.org/works?query=<query>&rows=25`
- PubMed search:
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<query>&retmode=json&retmax=25`
- PubMed records:
  `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=<pmids>&retmode=xml`
- arXiv: `https://export.arxiv.org/api/query?search_query=all:<query>&start=0&max_results=25`

Add filters through the API's own parameters (for example OpenAlex
`filter=from_publication_date:2015-01-01`). Keep the number of queries
proportionate to the question; ask before running a large batch.

## 3 · Record the search

Write `search_log.md` as you go. One entry per request:

- UTC timestamp, source name, exact URL, query, filters, HTTP result.
- Number of records returned and how many were screened in.
- Any failure, rate limit, or empty result.

Write `references.csv` with one row per record:

```csv
id,title,authors,year,venue,doi,pmid,arxiv_id,source_url,abstract_status,screening
```

`abstract_status` is `abstract-only`, `full-text`, or `none`.
`screening` is `include`, `exclude`, or `maybe`, with the reason in the review.

Deduplicate by DOI first, then by normalized title and year.

## 4 · Screen and synthesize

- Screen by title and abstract against the agreed criteria.
- Group included records by theme, method, population, or finding.
- For each theme: what the literature agrees on, where it conflicts, and what
  it has not addressed.
- Every claim in `review.md` cites a record from `references.csv`.
- Distinguish abstract-only evidence from full-text evidence. Do not present an
  abstract-only finding as confirmed.
- State the search limitations: databases, date range, query terms, and any
  records that could not be accessed.

For large result dumps use the `large-file` skill. For a taxonomy or trend
figure use the `publication-figures` skill.

## 5 · Failures and fallback

If an API is unreachable, returns an error, rate-limits you, or returns no
usable records:

1. Record the exact failure in `search_log.md`.
2. Tell the user which source failed and what is still available.
3. Ask for a staged corpus of PDFs or abstracts to review offline.

Do not replace a failed search with model memory, and do not invent a record to
fill a gap. A review with fewer, verified sources is acceptable; a fabricated
source is not.

## 6 · Deliverables

- `review.md` — the synthesized review with inline citation ids.
- `references.csv` — the screened record table.
- `search_log.md` — every query, URL, timestamp, result count, and failure.

State plainly that the review covers only the sources actually searched and
retrieved.
