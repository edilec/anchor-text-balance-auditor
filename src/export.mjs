/**
 * Reading, validating and merging anchor export documents.
 *
 * An export is what a crawler or a build step wrote down about the internal
 * anchors on a site: the anchors themselves, the targets they may point at,
 * and the contexts those anchors were found in. It may be sharded across
 * several JSON files named in the root document's `include` array. Every shard
 * is resolved against a declared root directory and confinement is checked on
 * the REAL path -- after symlinks are followed -- before a single byte is read.
 * Rejecting "../" lexically is not confinement: a symlink planted inside the
 * root points wherever it likes. The lexical gate is kept as a cheap first
 * check, never as the guarantee.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { CONTEXT_KINDS, EXPORT_SCHEMA_VERSION, isRecord, makeFinding } from './rules.mjs'

const DOCUMENT_KEYS = Object.freeze([
  'anchors',
  'contexts',
  'defaultLocale',
  'include',
  'schemaVersion',
  'site',
  'targets',
])
const CONTEXT_KEYS = Object.freeze(['id', 'kind', 'label'])
const TARGET_KEYS = Object.freeze(['aliases', 'id', 'title'])
const ANCHOR_KEYS = Object.freeze([
  'ariaLabel',
  'context',
  'from',
  'hasImage',
  'imageAlt',
  'labelledBy',
  'locale',
  'text',
  'title',
  'to',
])

const DRIVE_PREFIX = /^[A-Za-z]:/
const NUL = String.fromCharCode(0)

/** True when `candidateReal` is the real root itself or genuinely below it. */
export function isInside(rootReal, candidateReal) {
  if (candidateReal === rootReal) return true
  const rel = relative(rootReal, candidateReal)
  if (rel === '' || rel === '..' || isAbsolute(rel)) return false
  return !rel.startsWith(`..${sep}`)
}

export function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Lexical pre-check on an include path. A cheap first gate, not the
 * confinement guarantee -- the real-path assertion below is.
 */
export function unsafeIncludeReason(target) {
  if (typeof target !== 'string' || target === '') return 'must be a non-empty string'
  if (target.includes(NUL)) return 'must not contain a NUL character'
  if (target.includes('\\')) return 'must use "/" as its separator'
  if (target.startsWith('/')) return 'must be relative to the export root'
  if (DRIVE_PREFIX.test(target)) return 'must not be drive-qualified'
  const segments = target.split('/')
  if (segments.includes('..')) return 'must not contain a ".." segment'
  if (segments.includes('')) return 'must not contain an empty segment'
  return null
}

function invalid(file, pointer, message, evidence) {
  return makeFinding({
    ruleId: 'export-invalid',
    message,
    file,
    pointer,
    ...(evidence === undefined ? {} : { evidence }),
    suggestion: 'Correct the export document and run the audit again.',
  })
}

function unexpectedKey(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

function checkStringField(value, name, required) {
  if (value[name] === undefined) return required ? `is missing its "${name}" string` : null
  if (typeof value[name] !== 'string') return `has a non-string "${name}"`
  if (required && value[name] === '') return `has an empty "${name}"`
  return null
}

/**
 * Validate one export document.
 *
 * The first violation stops validation of that document and the document is
 * not merged. An export is machine-produced: a partially understood one is
 * evidence the tool does not have, so it is refused rather than half-used.
 */
export function validateDocument(data, file) {
  if (!isRecord(data)) return invalid(file, undefined, 'Export document must be a JSON object.')
  if (data.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    return invalid(
      file,
      '/schemaVersion',
      `Export schemaVersion must be "${EXPORT_SCHEMA_VERSION}".`,
      String(data.schemaVersion ?? 'missing'),
    )
  }
  const strayKey = unexpectedKey(data, DOCUMENT_KEYS)
  if (strayKey !== null) {
    return invalid(
      file,
      `/${strayKey}`,
      'Export document has an unrecognised key; a typo must not be silently ignored.',
      strayKey,
    )
  }
  if (data.site !== undefined && typeof data.site !== 'string') {
    return invalid(file, '/site', 'Export "site" must be a string when present.')
  }
  const localeProblem = checkStringField(data, 'defaultLocale', false)
  if (localeProblem !== null) return invalid(file, '/defaultLocale', `Export ${localeProblem}.`)
  if (data.defaultLocale !== undefined && data.defaultLocale === '') {
    return invalid(file, '/defaultLocale', 'Export "defaultLocale" must not be empty.')
  }

  for (const name of ['anchors', 'contexts', 'include', 'targets']) {
    if (data[name] !== undefined && !Array.isArray(data[name])) {
      return invalid(file, `/${name}`, `Export "${name}" must be an array when present.`)
    }
  }

  const contexts = data.contexts ?? []
  for (let index = 0; index < contexts.length; index += 1) {
    const pointer = `/contexts/${index}`
    const context = contexts[index]
    if (!isRecord(context)) return invalid(file, pointer, 'Context entry must be an object.')
    const stray = unexpectedKey(context, CONTEXT_KEYS)
    if (stray !== null) {
      return invalid(file, pointer, `Context entry has an unrecognised key "${stray}".`, stray)
    }
    for (const [name, required] of [['id', true], ['label', false]]) {
      const problem = checkStringField(context, name, required)
      if (problem !== null) return invalid(file, pointer, `Context entry ${problem}.`)
    }
    if (!CONTEXT_KINDS.includes(context.kind)) {
      return invalid(
        file,
        pointer,
        `Context "kind" must be one of ${CONTEXT_KINDS.join(', ')}.`,
        String(context.kind ?? 'missing'),
      )
    }
  }

  const targets = data.targets ?? []
  for (let index = 0; index < targets.length; index += 1) {
    const pointer = `/targets/${index}`
    const target = targets[index]
    if (!isRecord(target)) return invalid(file, pointer, 'Target entry must be an object.')
    const stray = unexpectedKey(target, TARGET_KEYS)
    if (stray !== null) {
      return invalid(file, pointer, `Target entry has an unrecognised key "${stray}".`, stray)
    }
    for (const [name, required] of [['id', true], ['title', false]]) {
      const problem = checkStringField(target, name, required)
      if (problem !== null) return invalid(file, pointer, `Target entry ${problem}.`)
    }
    if (target.aliases !== undefined) {
      if (!Array.isArray(target.aliases)) {
        return invalid(file, pointer, 'Target "aliases" must be an array when present.')
      }
      for (let alias = 0; alias < target.aliases.length; alias += 1) {
        if (typeof target.aliases[alias] !== 'string' || target.aliases[alias] === '') {
          return invalid(file, `${pointer}/aliases/${alias}`, 'Target alias must be a non-empty string.')
        }
      }
    }
  }

  const anchors = data.anchors ?? []
  for (let index = 0; index < anchors.length; index += 1) {
    const pointer = `/anchors/${index}`
    const anchor = anchors[index]
    if (!isRecord(anchor)) return invalid(file, pointer, 'Anchor entry must be an object.')
    const stray = unexpectedKey(anchor, ANCHOR_KEYS)
    if (stray !== null) {
      return invalid(file, pointer, `Anchor entry has an unrecognised key "${stray}".`, stray)
    }
    for (const [name, required] of [
      ['from', true],
      ['to', true],
      ['context', true],
      ['text', false],
      ['ariaLabel', false],
      ['imageAlt', false],
      ['labelledBy', false],
      ['title', false],
    ]) {
      const problem = checkStringField(anchor, name, required)
      if (problem !== null) return invalid(file, pointer, `Anchor entry ${problem}.`)
    }
    if (anchor.locale !== undefined && (typeof anchor.locale !== 'string' || anchor.locale === '')) {
      return invalid(file, pointer, 'Anchor "locale" must be a non-empty string when present.')
    }
    if (anchor.hasImage !== undefined && typeof anchor.hasImage !== 'boolean') {
      return invalid(file, pointer, 'Anchor "hasImage" must be a boolean when present.')
    }
    // An alt without an image is a contradictory record. Accepting it would let
    // an exporter bug hide an unnamed image anchor behind alt text that no
    // image carries, so it is refused instead of guessed at.
    if (anchor.imageAlt !== undefined && anchor.hasImage !== true) {
      return invalid(
        file,
        pointer,
        'Anchor has an "imageAlt" without "hasImage": true; the record contradicts itself.',
      )
    }
  }

  const includes = data.include ?? []
  for (let index = 0; index < includes.length; index += 1) {
    if (typeof includes[index] !== 'string') {
      return invalid(file, `/include/${index}`, 'Include entry must be a string.')
    }
  }
  return null
}

function duplicate(file, pointer, kind, id) {
  return invalid(
    file,
    pointer,
    `A second ${kind} is declared with id "${id}"; the later declaration was not merged.`,
    id,
  )
}

/**
 * Validate every document and merge the usable ones into flat anchor, target
 * and context tables. Pure: it never touches the filesystem.
 */
export function mergeDocuments(documents, limits) {
  const findings = []
  const anchors = []
  const targets = new Map()
  const contexts = new Map()
  let defaultLocale = null
  let defaultLocaleFile = null
  let usableDocuments = 0
  let anchorsDropped = 0
  let targetsDropped = 0
  let contextsDropped = 0

  for (const document of documents) {
    const problem = validateDocument(document.data, document.file)
    if (problem !== null) {
      findings.push(problem)
      continue
    }
    usableDocuments += 1
    const { data, file } = document

    if (data.defaultLocale !== undefined) {
      if (defaultLocale === null) {
        defaultLocale = data.defaultLocale
        defaultLocaleFile = file
      } else if (defaultLocale !== data.defaultLocale) {
        findings.push(
          invalid(
            file,
            '/defaultLocale',
            `Export declares defaultLocale "${data.defaultLocale}" but "${defaultLocaleFile}" already declared "${defaultLocale}"; the first one was kept.`,
            data.defaultLocale,
          ),
        )
      }
    }

    for (let index = 0; index < (data.contexts ?? []).length; index += 1) {
      const pointer = `/contexts/${index}`
      const context = data.contexts[index]
      if (contexts.has(context.id)) {
        findings.push(duplicate(file, pointer, 'context', context.id))
        continue
      }
      if (contexts.size >= limits.maxContexts) {
        contextsDropped += 1
        continue
      }
      contexts.set(context.id, {
        id: context.id,
        kind: context.kind,
        label: context.label,
        source: { file, pointer },
      })
    }

    for (let index = 0; index < (data.targets ?? []).length; index += 1) {
      const pointer = `/targets/${index}`
      const target = data.targets[index]
      if (targets.has(target.id)) {
        findings.push(duplicate(file, pointer, 'target', target.id))
        continue
      }
      if (targets.size >= limits.maxTargets) {
        targetsDropped += 1
        continue
      }
      targets.set(target.id, {
        id: target.id,
        title: target.title,
        aliases: [...(target.aliases ?? [])],
        source: { file, pointer },
      })
    }

    for (let index = 0; index < (data.anchors ?? []).length; index += 1) {
      if (anchors.length >= limits.maxAnchors) {
        anchorsDropped += 1
        continue
      }
      const anchor = data.anchors[index]
      anchors.push({
        from: anchor.from,
        to: anchor.to,
        context: anchor.context,
        locale: anchor.locale,
        text: anchor.text,
        ariaLabel: anchor.ariaLabel,
        imageAlt: anchor.imageAlt,
        hasImage: anchor.hasImage === true,
        labelledBy: anchor.labelledBy,
        title: anchor.title,
        source: { file, pointer: `/anchors/${index}` },
      })
    }
  }

  const firstFile = documents.length > 0 ? documents[0].file : undefined
  if (anchorsDropped > 0) {
    findings.push(
      makeFinding({
        ruleId: 'too-many-anchors',
        message: `Export exceeds the ${limits.maxAnchors} anchor limit; ${anchorsDropped} anchor(s) were not audited.`,
        file: firstFile,
        suggestion: 'Shard the export or raise --max-anchors; the reported balance is partial.',
      }),
    )
  }
  if (targetsDropped > 0) {
    findings.push(
      makeFinding({
        ruleId: 'too-many-targets',
        message: `Export exceeds the ${limits.maxTargets} target limit; ${targetsDropped} target(s) were not loaded.`,
        file: firstFile,
        suggestion: 'Shard the export or raise --max-targets; anchors to the dropped targets cannot be judged.',
      }),
    )
  }
  if (contextsDropped > 0) {
    findings.push(
      makeFinding({
        ruleId: 'too-many-contexts',
        message: `Export exceeds the ${limits.maxContexts} context limit; ${contextsDropped} context(s) were not loaded.`,
        file: firstFile,
        suggestion: 'Reduce the number of declared contexts or raise --max-contexts.',
      }),
    )
  }

  return {
    anchors,
    targets,
    contexts,
    defaultLocale,
    findings,
    usableDocuments,
  }
}

async function readDocument(realPath, file, limits) {
  let info
  try {
    info = await stat(realPath)
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'export-unreadable',
        message: `Export file could not be examined: ${error.code ?? 'unknown error'}.`,
        file,
      }),
    }
  }
  if (!info.isFile()) {
    return {
      finding: makeFinding({
        ruleId: 'export-unreadable',
        message: 'Export path is not a regular file.',
        file,
      }),
    }
  }
  if (info.size > limits.maxFileBytes) {
    return {
      finding: makeFinding({
        ruleId: 'file-too-large',
        message: `Export file is ${info.size} bytes, above the ${limits.maxFileBytes} byte limit; it was not read.`,
        file,
        suggestion: 'Shard the export with "include", or raise --max-file-bytes.',
      }),
    }
  }

  let bytes
  try {
    bytes = await readFile(realPath)
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'export-unreadable',
        message: `Export file could not be read: ${error.code ?? 'unknown error'}.`,
        file,
      }),
    }
  }

  let text
  try {
    // Strict decoding. Encoding validity is never inferred from decoded text:
    // an export may legitimately contain U+FFFD, and undecodable bytes must
    // fail rather than turn into replacement characters nobody notices.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      finding: makeFinding({
        ruleId: 'export-undecodable',
        message: 'Export file is not valid UTF-8; it was not audited.',
        file,
        suggestion: 'Re-encode the export as UTF-8.',
      }),
    }
  }

  try {
    return { data: JSON.parse(text) }
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'export-invalid',
        message: `Export file is not valid JSON: ${error.message}`,
        file,
      }),
    }
  }
}

/**
 * Read the root export and, depth-first in declaration order, every shard it
 * includes. Returns the documents that were read plus findings for the ones
 * that were refused or unreadable.
 */
export async function readExportDocuments({ exportReal, rootReal, limits }) {
  const documents = []
  const findings = []
  const seen = new Map()
  let includedFiles = 0
  let limitReported = false

  const load = async (realPath, file, depth) => {
    seen.set(realPath, file)
    const result = await readDocument(realPath, file, limits)
    if (result.finding !== undefined) {
      findings.push(result.finding)
      return
    }
    documents.push({ file, data: result.data })

    const includes =
      isRecord(result.data) && Array.isArray(result.data.include) ? result.data.include : []
    for (let index = 0; index < includes.length; index += 1) {
      const pointer = `/include/${index}`
      const target = includes[index]
      const reason = unsafeIncludeReason(target)
      if (reason !== null) {
        findings.push(
          makeFinding({
            ruleId: 'unsafe-include-path',
            message: `Include path ${reason}; it was refused and not read.`,
            file,
            pointer,
            evidence: typeof target === 'string' ? target : typeof target,
          }),
        )
        continue
      }
      if (depth + 1 > limits.maxIncludeDepth) {
        findings.push(
          makeFinding({
            ruleId: 'include-depth-exceeded',
            message: `Include nesting exceeds the ${limits.maxIncludeDepth} level limit; this shard was not read.`,
            file,
            pointer,
            evidence: target,
            suggestion: 'Flatten the export or raise --max-include-depth.',
          }),
        )
        continue
      }
      if (includedFiles >= limits.maxIncludeFiles) {
        if (!limitReported) {
          limitReported = true
          findings.push(
            makeFinding({
              ruleId: 'too-many-include-files',
              message: `Export includes more than the ${limits.maxIncludeFiles} shard limit; the remaining shards were not read.`,
              file,
              pointer,
              suggestion: 'Reduce the number of shards or raise --max-include-files.',
            }),
          )
        }
        continue
      }

      const candidate = resolve(rootReal, ...target.split('/'))
      let candidateReal
      try {
        candidateReal = await realpath(candidate)
      } catch (error) {
        includedFiles += 1
        findings.push(
          makeFinding({
            ruleId: 'export-unreadable',
            message: `Included shard could not be resolved: ${error.code ?? 'unknown error'}.`,
            file,
            pointer,
            evidence: target,
          }),
        )
        continue
      }
      // The real path, after every symlink, must still be inside the real root.
      // Both sides are real paths: comparing a resolved root against an
      // unresolved candidate refuses files that are genuinely inside the root.
      if (!isInside(rootReal, candidateReal)) {
        includedFiles += 1
        findings.push(
          makeFinding({
            ruleId: 'path-escapes-root',
            message: 'Included shard resolves outside the export root; it was refused and not read.',
            file,
            pointer,
            evidence: target,
            suggestion: 'Keep every shard, and every symlink to one, inside the export root.',
          }),
        )
        continue
      }
      if (seen.has(candidateReal)) {
        findings.push(
          makeFinding({
            ruleId: 'duplicate-include',
            message: `Shard "${seen.get(candidateReal)}" is included more than once; it was read only the first time.`,
            file,
            pointer,
            evidence: target,
          }),
        )
        continue
      }
      includedFiles += 1
      await load(candidateReal, toPosix(relative(rootReal, candidateReal)), depth + 1)
    }
  }

  await load(exportReal, toPosix(relative(rootReal, exportReal)), 0)
  return { documents, findings, includedFiles }
}
