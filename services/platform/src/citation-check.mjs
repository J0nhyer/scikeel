// Structural validation for citation_check.json v1. It verifies the artifact
// shape and referenced workspace paths only; the scientific support verdicts
// remain agent-reported and are not independently judged here.
const VERSION = 1;
const EVIDENCE_LEVELS = ["pdf-text", "html-text", "abstract-only", "none"];
const SUPPORTS = ["supported", "partial", "unsupported", "unverifiable"];
const FULL_TEXT_STATUSES = ["pdf-text", "html-text", "scanned", "unavailable"];
const SCREENINGS = ["include", "exclude", "maybe"];
const FULL_TEXT_LEVELS = new Set(["pdf-text", "html-text"]);
const NOT_CITED_OK = new Set(["exclude", "maybe"]);

const invalid = (message) =>
  Object.assign(new Error(`citation_check.json ${message}`), { reportInvalid: true });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const list = (value) => (Array.isArray(value) ? value : null);

function workspacePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 500 &&
    !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

const oneOf = (values) => values.join(", ");

/**
 * Validate a parsed citation_check.json v1 document.
 * `exists(path)` reports whether a workspace-relative evidence path exists; the
 * delivery path supplies the workspace-scoped reader. Field errors carry
 * `reportInvalid` so the delivery gate can surface the exact invalid path.
 */
export async function validateCitationCheck(value, { exists = () => true } = {}) {
  if (!object(value)) throw invalid("must be a JSON object");
  if (value.version !== VERSION) throw invalid(`version must be ${VERSION}`);
  if (!Array.isArray(value.references)) throw invalid("references must be an array");

  const references = new Map();
  for (let index = 0; index < value.references.length; index++) {
    const reference = value.references[index];
    if (!object(reference)) throw invalid(`references[${index}] must be an object`);
    if (!nonEmpty(reference.id)) throw invalid(`references[${index}].id must be a non-empty string`);
    if (references.has(reference.id)) throw invalid(`references[${index}].id "${reference.id}" is duplicated`);
    if (reference.screening !== undefined && !SCREENINGS.includes(reference.screening))
      throw invalid(`references[${index}].screening must be one of ${oneOf(SCREENINGS)}`);
    if (reference.full_text_status !== undefined && !FULL_TEXT_STATUSES.includes(reference.full_text_status))
      throw invalid(`references[${index}].full_text_status must be one of ${oneOf(FULL_TEXT_STATUSES)}`);
    if (reference.retracted !== undefined && typeof reference.retracted !== "boolean")
      throw invalid(`references[${index}].retracted must be a boolean`);
    if (reference.metadata !== undefined && typeof reference.metadata !== "string")
      throw invalid(`references[${index}].metadata must be a string`);
    if (reference.doi !== undefined && typeof reference.doi !== "string")
      throw invalid(`references[${index}].doi must be a string`);
    if (reference.full_text_path !== undefined && reference.full_text_path !== "") {
      if (!workspacePath(reference.full_text_path))
        throw invalid(`references[${index}].full_text_path must be a workspace-relative file path`);
      if (!(await exists(reference.full_text_path)))
        throw invalid(`references[${index}].full_text_path "${reference.full_text_path}" does not exist`);
    } else if (FULL_TEXT_LEVELS.has(reference.full_text_status)) {
      throw invalid(`references[${index}].full_text_path is required for ${reference.full_text_status} evidence`);
    }
    references.set(reference.id, reference);
  }

  if (!Array.isArray(value.claims) || value.claims.length === 0)
    throw invalid("claims must contain at least one claim");
  const claims = [];
  for (let index = 0; index < value.claims.length; index++) {
    const claim = value.claims[index];
    if (!object(claim)) throw invalid(`claims[${index}] must be an object`);
    const claimId = claim.claim_id ?? claim.id;
    if (!nonEmpty(claimId)) throw invalid(`claims[${index}].claim_id must be a non-empty string`);
    if (typeof claim.section !== "string") throw invalid(`claims[${index}].section must be a string`);
    if (!nonEmpty(claim.claim)) throw invalid(`claims[${index}].claim must be a non-empty string`);
    const citations = list(claim.citations);
    if (!citations || citations.length === 0)
      throw invalid(`claims[${index}].citations must be a non-empty array of reference ids`);
    for (let cited = 0; cited < citations.length; cited++) {
      if (!nonEmpty(citations[cited]))
        throw invalid(`claims[${index}].citations[${cited}] must be a non-empty reference id`);
      if (!references.has(citations[cited]))
        throw invalid(`claims[${index}].citations[${cited}] "${citations[cited]}" is not in references`);
    }
    if (!EVIDENCE_LEVELS.includes(claim.evidence_level))
      throw invalid(`claims[${index}].evidence_level must be one of ${oneOf(EVIDENCE_LEVELS)}`);
    if (!SUPPORTS.includes(claim.support))
      throw invalid(`claims[${index}].support must be one of ${oneOf(SUPPORTS)}`);
    if (typeof claim.evidence !== "string") throw invalid(`claims[${index}].evidence must be a string`);
    if (claim.evidence_level !== "none") {
      if (!workspacePath(claim.evidence_path))
        throw invalid(`claims[${index}].evidence_path must be a workspace-relative file path for ${claim.evidence_level} evidence`);
      if (!(await exists(claim.evidence_path)))
        throw invalid(`claims[${index}].evidence_path "${claim.evidence_path}" does not exist`);
    } else if (claim.evidence_path !== undefined && claim.evidence_path !== "" && !workspacePath(claim.evidence_path)) {
      throw invalid(`claims[${index}].evidence_path must be a workspace-relative file path`);
    }
    claims.push({
      claim_id: claimId,
      section: claim.section,
      claim: claim.claim,
      citations: [...citations],
      evidence_level: claim.evidence_level,
      support: claim.support,
      evidence: claim.evidence,
      evidence_path: claim.evidence_path ?? null,
    });
  }

  if (!object(value.usage)) throw invalid("usage must be an object");
  const usage = {};
  for (const key of ["cited", "uncited", "unknown"]) {
    const entries = list(value.usage[key]);
    if (!entries) throw invalid(`usage.${key} must be an array of reference ids`);
    for (let index = 0; index < entries.length; index++) {
      if (!nonEmpty(entries[index]))
        throw invalid(`usage.${key}[${index}] must be a non-empty reference id`);
    }
    usage[key] = [...entries];
  }
  for (let index = 0; index < usage.cited.length; index++) {
    if (!references.has(usage.cited[index]))
      throw invalid(`usage.cited[${index}] "${usage.cited[index]}" is not in references`);
  }
  for (let index = 0; index < usage.uncited.length; index++) {
    const refId = usage.uncited[index];
    if (!references.has(refId))
      throw invalid(`usage.uncited[${index}] "${refId}" is not in references`);
    if (!NOT_CITED_OK.has(references.get(refId).screening))
      throw invalid(`usage.uncited[${index}] "${refId}" must be cited in review.md because screening is include or unspecified`);
  }
  if (usage.unknown.length)
    throw invalid(`usage.unknown must be empty for delivery; found ${usage.unknown.map((id) => `"${id}"`).join(", ")}`);
  const accounted = new Set([...usage.cited, ...usage.uncited]);
  for (let index = 0; index < value.references.length; index++) {
    const refId = value.references[index].id;
    if (!accounted.has(refId))
      throw invalid(`references[${index}] "${refId}" must appear in usage.cited or usage.uncited`);
  }

  if (!object(value.summary)) throw invalid("summary must be an object");

  return { version: VERSION, references: [...references.values()], claims, usage, summary: value.summary };
}
