/**
 * anchor-text-balance-auditor
 *
 * Reads an export of internal anchors, computes each anchor's accessible name,
 * groups the anchor variants by target, context and locale, and reports empty,
 * misleading and over-repeated link text.
 *
 * The tool never fetches anything. Everything it knows comes from the export it
 * was handed, which is why an anchor whose name depends on aria-labelledby, an
 * anchor in a context nobody declared, an anchor with no locale and an anchor
 * pointing at an undeclared target are each reported as UNKNOWN and make the
 * whole run incomplete. An export that did not describe something cannot be
 * used to prove that thing is fine.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

import { auditAnchors } from './anchors.mjs'
import { isInside, mergeDocuments, readExportDocuments, toPosix } from './export.mjs'
import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  REPORT_SCHEMA_VERSION,
  RULE_SEVERITY,
  TOOL_ID,
  isRecord,
  makeFinding,
  singleLine,
  sortFindings,
  validateLimits,
} from './rules.mjs'

export {
  CONTEXT_KINDS,
  DEFAULT_LIMITS,
  EXPORT_SCHEMA_VERSION,
  INCOMPLETE_RULES,
  NAME_SOURCES,
  REPORT_SCHEMA_VERSION,
  RULE_SEVERITY,
  SEVERITIES,
  TOOL_ID,
  byCodeUnit,
  excerpt,
  forcesIncomplete,
  listSome,
  parseFailureDetail,
  severityOf,
  singleLine,
  validateLimits,
} from './rules.mjs'
export { isInside, mergeDocuments, unsafeIncludeReason, validateDocument } from './export.mjs'
export { accessibleName, auditAnchors, buildNameIndex, normaliseName } from './anchors.mjs'

const EMPTY_COUNTS = Object.freeze({
  anchors: 0,
  targets: 0,
  contexts: 0,
  groups: 0,
  variants: 0,
  named: 0,
  unnamed: 0,
  unresolvedNames: 0,
  imageOnlyNamed: 0,
  editorialAnchors: 0,
  navigationAnchors: 0,
  unscoredAnchors: 0,
  misleading: 0,
  overRepeated: 0,
  navigationRepeats: 0,
  ambiguous: 0,
})

function validateDefaultLocale(locale) {
  if (locale === undefined || locale === null) return null
  if (typeof locale !== 'string' || locale.trim() === '') {
    throw new TypeError('Default locale must be a non-empty string')
  }
  return locale
}

/**
 * Assemble the report envelope.
 *
 * `status` is derived here and nowhere else: incomplete whenever any emitted
 * rule is in INCOMPLETE_RULES, otherwise fail when anything is an error,
 * otherwise pass. One choke point means no code path can arrive at "pass"
 * carrying evidence it never obtained.
 */
function buildReport({ findings, groups, counts, documents, limits }) {
  let ordered = sortFindings(findings)
  if (ordered.length > limits.maxFindings) {
    const dropped = ordered.length - limits.maxFindings
    ordered = ordered.slice(0, limits.maxFindings)
    // Appended after the sort, deliberately last, so the notice is never the
    // thing that the truncation hides.
    ordered.push(
      makeFinding({
        ruleId: 'too-many-findings',
        message: `Report exceeds the ${limits.maxFindings} finding limit; ${dropped} finding(s) were not reported.`,
        suggestion: 'Raise --max-findings, or fix the reported problems and run the audit again.',
      }),
    )
  }

  const tally = (list) => {
    const counted = { errors: 0, warnings: 0, info: 0, incomplete: false }
    for (const finding of list) {
      if (finding.severity === 'error') counted.errors += 1
      else if (finding.severity === 'warning') counted.warnings += 1
      else counted.info += 1
      if (INCOMPLETE_RULES.includes(finding.ruleId)) counted.incomplete = true
    }
    return counted
  }

  let { errors, warnings, info, incomplete } = tally(ordered)
  // Green on no evidence is a defect, not a pass.
  if (!incomplete && errors === 0 && counts.anchors === 0) {
    ordered = sortFindings([
      ...ordered,
      makeFinding({
        ruleId: 'empty-export',
        message: 'No anchor was audited, so this run has no evidence to pass on.',
        suggestion: 'Supply an export whose "anchors" array lists the internal links that were found.',
      }),
    ])
    ;({ errors, warnings, info, incomplete } = tally(ordered))
  }

  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.anchors,
      errors,
      warnings,
      info,
      documents,
      targets: counts.targets,
      contexts: counts.contexts,
      groups: counts.groups,
      variants: counts.variants,
      named: counts.named,
      unnamed: counts.unnamed,
      unresolvedNames: counts.unresolvedNames,
      imageOnlyNamed: counts.imageOnlyNamed,
      editorialAnchors: counts.editorialAnchors,
      navigationAnchors: counts.navigationAnchors,
      unscoredAnchors: counts.unscoredAnchors,
      misleading: counts.misleading,
      overRepeated: counts.overRepeated,
      navigationRepeats: counts.navigationRepeats,
      ambiguous: counts.ambiguous,
    },
    findings: ordered,
    groups,
  }
}

/**
 * Audit already-loaded export documents.
 *
 * `documents` is an array of `{ file, data }`, where `file` is the path the
 * report should name and `data` is the parsed JSON. Pure, so every rule is
 * testable without touching a filesystem.
 */
export function auditExportDocuments({ documents, defaultLocale, limits, extraFindings = [] } = {}) {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array')
  for (const document of documents) {
    if (!isRecord(document) || typeof document.file !== 'string' || document.file === '') {
      throw new TypeError('Every document needs a non-empty file name')
    }
  }
  const activeLimits = validateLimits(limits ?? {})
  const localeOverride = validateDefaultLocale(defaultLocale)

  const merged = mergeDocuments(documents, activeLimits)

  if (merged.usableDocuments === 0) {
    return buildReport({
      findings: [...extraFindings, ...merged.findings],
      groups: [],
      counts: { ...EMPTY_COUNTS },
      documents: documents.length,
      limits: activeLimits,
    })
  }

  const audit = auditAnchors({
    anchors: merged.anchors,
    targets: merged.targets,
    contexts: merged.contexts,
    defaultLocale: localeOverride ?? merged.defaultLocale,
    limits: activeLimits,
  })

  return buildReport({
    findings: [...extraFindings, ...merged.findings, ...audit.findings],
    groups: audit.groups,
    counts: audit.counts,
    documents: documents.length,
    limits: activeLimits,
  })
}

/**
 * Read an export file (and the shards it includes) and audit it.
 *
 * A configuration problem -- a missing export root, an export outside that
 * root, an unknown limit -- throws, because the run never had a subject. An
 * input that could not be read, decoded or parsed returns an `incomplete`
 * report naming the file, because the run had a subject and failed to obtain
 * evidence about it.
 */
export async function auditExportFile({ exportFile, root, defaultLocale, limits } = {}) {
  if (typeof exportFile !== 'string' || exportFile.trim() === '') {
    throw new TypeError('An export file path is required')
  }
  const activeLimits = validateLimits(limits ?? {})
  const localeOverride = validateDefaultLocale(defaultLocale)

  const exportAbsolute = resolve(exportFile)
  const rootAbsolute = root === undefined || root === null ? dirname(exportAbsolute) : resolve(root)

  let rootReal
  try {
    rootReal = await realpath(rootAbsolute)
  } catch (error) {
    throw new TypeError(`Export root could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  // Where the operator SAID the export is: the real parent directory plus the
  // given name. Pointing outside the declared root is a configuration mistake,
  // so it throws; following a symlink out of the root is an attack on
  // confinement, so it is refused and reported below.
  let declaredReal
  try {
    declaredReal = join(await realpath(dirname(exportAbsolute)), basename(exportAbsolute))
  } catch (error) {
    throw new TypeError(`Export directory could not be resolved: ${error.code ?? 'unknown error'}`)
  }
  const lexicalRelative = relative(rootReal, declaredReal)
  if (
    lexicalRelative === '' ||
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new TypeError('Export file is outside the export root')
  }
  const exportName = toPosix(lexicalRelative)

  const fail = (finding) =>
    buildReport({
      findings: [finding],
      groups: [],
      counts: { ...EMPTY_COUNTS },
      documents: 0,
      limits: activeLimits,
    })

  let exportReal
  try {
    exportReal = await realpath(exportAbsolute)
  } catch (error) {
    return fail(
      makeFinding({
        ruleId: 'export-unreadable',
        message: `Export file could not be resolved: ${error.code ?? 'unknown error'}.`,
        file: exportName,
      }),
    )
  }
  // The export itself is confined too, and its symlink is followed BEFORE the
  // check rather than after it. Both sides are real paths, so a legitimate
  // file reached through a symlinked root is accepted, not refused.
  if (!isInside(rootReal, exportReal)) {
    return fail(
      makeFinding({
        ruleId: 'path-escapes-root',
        message: 'Export file resolves outside the export root; it was refused and not read.',
        file: exportName,
        suggestion: 'Point --root at a directory that really contains the export.',
      }),
    )
  }

  const read = await readExportDocuments({ exportReal, rootReal, limits: activeLimits })
  return auditExportDocuments({
    documents: read.documents,
    defaultLocale: localeOverride ?? undefined,
    limits: activeLimits,
    extraFindings: read.findings,
  })
}

const SEVERITY_WIDTH = 7

/**
 * The human report is line-oriented, so one finding is exactly one line.
 *
 * `severity` and `ruleId` come from the frozen table, but `location.file` and
 * `message` carry export-derived text: an anchor's text, a page id, a context
 * id or a locale tag may hold a newline, and printing it raw would let an
 * export forge finding lines that no finding stands behind.
 *
 * Both are already flattened by `makeFinding`, because the JSON report is
 * line-oriented to plenty of consumers too and `JSON.stringify` escapes none
 * of U+2028, U+2029 or U+0085. Flattening again here costs nothing and keeps
 * the guarantee true for a report this function is handed from elsewhere.
 */
export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${TOOL_ID}: status ${report.status}`,
    `${summary.checked} anchor(s) from ${summary.documents} export document(s); ${summary.named} named, ${summary.unnamed} unnamed, ${summary.unresolvedNames} unresolved, ${summary.imageOnlyNamed} image-only but named.`,
    `${summary.editorialAnchors} editorial and ${summary.navigationAnchors} navigation anchor(s) over ${summary.contexts} declared context(s); ${summary.unscoredAnchors} not scored.`,
    `${summary.variants} anchor variant(s) in ${summary.groups} target/context/locale group(s): ${summary.overRepeated} over-repeated, ${summary.navigationRepeats} expected navigation repeat(s), ${summary.ambiguous} ambiguous, ${summary.misleading} misleading.`,
    `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info.`,
  ]
  for (const finding of report.findings) {
    const place = [finding.location.file, finding.location.pointer]
      .filter(Boolean)
      .map(singleLine)
      .join(' ')
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place === '' ? '(configuration)' : place} ${finding.ruleId} ${singleLine(finding.message)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY))
export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))
