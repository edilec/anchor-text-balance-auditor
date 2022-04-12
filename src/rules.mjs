/**
 * Identity, bounds, and the single severity table.
 *
 * Severity is what separates "this run failed" from "this run passed", so it
 * lives in exactly one frozen table and every finding takes its value from
 * there. A rule id that is not in the table throws instead of defaulting to
 * something harmless, and `docs/anchor-rules.md` is asserted against this table
 * in both directions by the test suite.
 */

export const TOOL_ID = 'anchor-text-balance-auditor'
export const REPORT_SCHEMA_VERSION = '1'
export const EXPORT_SCHEMA_VERSION = '1'

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/**
 * The two context kinds this tool scores separately. Navigation anchors repeat
 * by design -- a "Home" link in every header is not an editorial pattern -- so
 * repetition inside a navigation context is reported as expected, while the
 * same repetition among editorial anchors is raised for review.
 */
export const CONTEXT_KINDS = Object.freeze(['editorial', 'navigation'])

/** Where an anchor's accessible name came from, or why there is none. */
export const NAME_SOURCES = Object.freeze([
  'aria-label',
  'image-alt',
  'none',
  'text',
  'text+image-alt',
  'title',
  'unresolved',
])

/**
 * Explicit bounds. Every one of these is enforced, reported when it is hit,
 * and covered by a test; a limit that is documented but never wired through is
 * a lie that turns a real failure into a green run.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxAnchors: 50000,
  maxTargets: 20000,
  maxContexts: 512,
  maxFileBytes: 8388608,
  maxIncludeDepth: 4,
  maxIncludeFiles: 64,
  maxListed: 10,
  maxFindings: 5000,
  maxEditorialRepeats: 3,
})

export const RULE_SEVERITY = Object.freeze({
  'ambiguous-anchor-text': 'warning',
  'anchor-name-unresolved': 'warning',
  'context-undeclared': 'warning',
  'duplicate-include': 'info',
  'empty-anchor-text': 'error',
  'empty-export': 'error',
  'export-invalid': 'error',
  'export-undecodable': 'error',
  'export-unreadable': 'error',
  'file-too-large': 'error',
  'image-anchor-unnamed': 'error',
  'include-depth-exceeded': 'error',
  'locale-undeclared': 'warning',
  'misleading-anchor-text': 'error',
  'navigation-repetition-expected': 'info',
  'over-repeated-anchor-text': 'warning',
  'path-escapes-root': 'error',
  'target-undeclared': 'warning',
  'too-many-anchors': 'error',
  'too-many-contexts': 'error',
  'too-many-findings': 'error',
  'too-many-include-files': 'error',
  'too-many-targets': 'error',
  'unsafe-include-path': 'error',
})

/**
 * Rules that force `status: "incomplete"`.
 *
 * Declared as data rather than as `incomplete = true` scattered through the
 * code, so the invariant has one place to be removed from and
 * `test/incomplete.test.mjs` can assert a real scenario for every entry. Four
 * of these are warnings -- an unresolved accessible name, an anchor in a
 * context nobody declared, an anchor whose locale is unknown, and an anchor
 * pointing at a target the export does not describe. For those four this list
 * is the ONLY thing standing between missing evidence and a green run.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'anchor-name-unresolved',
  'context-undeclared',
  'empty-export',
  'export-invalid',
  'export-undecodable',
  'export-unreadable',
  'file-too-large',
  'include-depth-exceeded',
  'locale-undeclared',
  'path-escapes-root',
  'target-undeclared',
  'too-many-anchors',
  'too-many-contexts',
  'too-many-findings',
  'too-many-include-files',
  'too-many-targets',
  'unsafe-include-path',
])

const EVIDENCE_LIMIT = 160
// Everything a line-oriented consumer may treat as a line break or a control
// sequence: C0 controls, DEL, the C1 range (U+0085 NEL included -- Python's
// splitlines breaks on it), and the two Unicode line separators.
const UNPRINTABLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** Plain code-unit ordering. Locale collation varies with the ICU data a Node build ships. */
export function byCodeUnit(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

export function severityOf(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return RULE_SEVERITY[ruleId]
}

export function forcesIncomplete(ruleId) {
  severityOf(ruleId)
  return INCOMPLETE_RULES.includes(ruleId)
}

/**
 * Flatten everything that could end a line. Anchor text, page ids, context ids
 * and locale tags are export content: data, never an instruction, and never a
 * report line of their own.
 */
export function singleLine(value) {
  return String(value).replace(UNPRINTABLE, ' ')
}

/** A bounded, flattened excerpt. Export content is data, never an instruction. */
export function excerpt(value) {
  const flattened = singleLine(value).trim()
  if (flattened.length <= EVIDENCE_LIMIT) return flattened
  return `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

/**
 * Join a bounded list of export-derived strings for a message or evidence
 * field. Exceeding the limit says so rather than trailing off silently.
 *
 * `total` is how many values there really are, which may be larger than
 * `values` when the caller stopped collecting samples at the limit. Passing it
 * keeps the "+N more" honest instead of implying the list was complete.
 */
export function listSome(values, limit, total = values.length) {
  const shown = values.slice(0, limit).map((value) => excerpt(value))
  const hidden = Math.max(total - shown.length, 0)
  return hidden > 0 ? `${shown.join(', ')} (+${hidden} more)` : shown.join(', ')
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build one finding. Severity is never passed in: it is looked up, so a caller
 * cannot quietly downgrade a refusal at its construction site.
 */
export function makeFinding({ ruleId, message, file, pointer, evidence, suggestion }) {
  const location = {}
  if (typeof file === 'string' && file !== '') location.file = file
  if (typeof pointer === 'string' && pointer !== '') location.pointer = pointer

  const finding = {
    ruleId,
    severity: severityOf(ruleId),
    message: String(message),
    location,
  }
  if (evidence !== undefined) finding.evidence = excerpt(evidence)
  if (suggestion !== undefined) finding.suggestion = String(suggestion)
  return finding
}

/** Documented order: location.file, then location.pointer, then ruleId, then message. */
export function sortFindings(findings) {
  return [...findings].sort(
    (left, right) =>
      byCodeUnit(left.location.file ?? '', right.location.file ?? '') ||
      byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '') ||
      byCodeUnit(left.ruleId, right.ruleId) ||
      byCodeUnit(left.message, right.message),
  )
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}
