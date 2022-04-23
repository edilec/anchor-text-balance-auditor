/**
 * Accessible names, anchor-variant grouping, and the balance rules.
 *
 * Two distinctions carry this tool:
 *
 * 1. An image-only anchor is not an empty anchor. `<a href="/"><img alt="Home">
 *    </a>` has the accessible name "Home"; reporting it as empty is a false
 *    positive, and a false refusal is a bug like any other. A truly empty
 *    anchor has no aria-label, no text node, no image alt and no title.
 * 2. Navigation anchors repeat by design. The same "Documentation" link in
 *    every header is the site working as intended, so repetition inside a
 *    navigation context is reported as expected and never counted against the
 *    editorial repetition budget. The same repetition among in-body editorial
 *    anchors is what this tool exists to surface.
 *
 * Everything here is pure: the audit takes already-merged tables and returns
 * findings, groups and counts, so the rules are testable without a filesystem.
 */

import { listSome, makeFinding, singleLine } from './rules.mjs'

/**
 * Grouping key for an anchor name.
 *
 * Whitespace is collapsed and case is folded with `String.prototype
 * .toLowerCase`, which is locale-independent by specification -- unlike
 * `toLocaleLowerCase`, whose result depends on the host locale and would make
 * two runs of the same export disagree.
 */
export function normaliseName(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The accessible name of one exported anchor, in the order a browser computes
 * it, with the parts an export can actually carry.
 *
 * `aria-labelledby` cannot be resolved from an export -- the elements it
 * points at are not in the record -- so an anchor that declares one is
 * reported `unresolved`. Unread evidence is never a verdict: it is not "named"
 * and it is not "empty".
 *
 * An aria-label that is empty or whitespace is ignored, exactly as the
 * accessible name computation ignores it, and the content is used instead.
 */
export function accessibleName(anchor) {
  if (typeof anchor.labelledBy === 'string' && anchor.labelledBy.trim() !== '') {
    return { name: null, source: 'unresolved' }
  }
  const aria = typeof anchor.ariaLabel === 'string' ? anchor.ariaLabel : ''
  if (aria.trim() !== '') return { name: aria, source: 'aria-label' }

  const text = typeof anchor.text === 'string' ? anchor.text : ''
  const alt = typeof anchor.imageAlt === 'string' ? anchor.imageAlt : ''
  const hasText = text.trim() !== ''
  const hasAlt = alt.trim() !== ''
  if (hasText && hasAlt) return { name: `${text} ${alt}`, source: 'text+image-alt' }
  if (hasText) return { name: text, source: 'text' }
  if (hasAlt) return { name: alt, source: 'image-alt' }

  const title = typeof anchor.title === 'string' ? anchor.title : ''
  if (title.trim() !== '') return { name: title, source: 'title' }

  return { name: null, source: 'none' }
}

function compareParts(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function keyOf(parts) {
  return JSON.stringify(parts)
}

/**
 * Build the normalised-name -> declared-target index used by the misleading
 * rule. A "misleading" anchor is never a judgement of writing quality: it is an
 * anchor whose accessible name is the declared title or alias of a DIFFERENT
 * target than the one it links to. Without a declared name for a target there
 * is no evidence, and the rule stays silent.
 */
export function buildNameIndex(targets) {
  const index = new Map()
  for (const target of targets.values()) {
    const names = [target.title, ...(target.aliases ?? [])]
    for (const name of names) {
      if (typeof name !== 'string' || name.trim() === '') continue
      const normalised = normaliseName(name)
      if (!index.has(normalised)) index.set(normalised, new Set())
      index.get(normalised).add(target.id)
    }
  }
  return index
}

/**
 * Audit merged anchors.
 *
 * `anchors` is the flat list produced by mergeDocuments, `targets` and
 * `contexts` are Maps keyed by id, `defaultLocale` is the locale an anchor
 * without its own falls back to, or null when nobody declared one.
 */
export function auditAnchors({ anchors, targets, contexts, defaultLocale, limits }) {
  const findings = []
  const nameIndex = buildNameIndex(targets)

  const groups = new Map()
  const nameTargets = new Map()
  const undeclaredContexts = new Map()
  const undeclaredTargets = new Map()
  const localeless = []

  const counts = {
    anchors: anchors.length,
    targets: targets.size,
    contexts: contexts.size,
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
  }

  for (const anchor of anchors) {
    const { file, pointer } = anchor.source
    const { name, source } = accessibleName(anchor)
    const context = contexts.get(anchor.context)
    const locale = anchor.locale ?? defaultLocale ?? null
    const declaredTarget = targets.get(anchor.to)

    if (source === 'unresolved') {
      counts.unresolvedNames += 1
      findings.push(
        makeFinding({
          ruleId: 'anchor-name-unresolved',
          message: `Anchor from "${anchor.from}" to "${anchor.to}" takes its name from aria-labelledby, which this export does not resolve; its text was not audited.`,
          file,
          pointer,
          evidence: anchor.labelledBy,
          suggestion:
            'Record the resolved accessible name in "ariaLabel", or drop aria-labelledby from the anchor.',
        }),
      )
    } else if (name === null) {
      counts.unnamed += 1
      if (anchor.hasImage) {
        findings.push(
          makeFinding({
            ruleId: 'image-anchor-unnamed',
            message:
              anchor.imageAlt === undefined
                ? `Anchor from "${anchor.from}" to "${anchor.to}" contains an image with no alt and no other text, so it has no accessible name.`
                : `Anchor from "${anchor.from}" to "${anchor.to}" contains an image whose alt is empty and has no other text, so it has no accessible name.`,
            file,
            pointer,
            evidence: anchor.to,
            suggestion: 'Give the image an alt that names where the link goes.',
          }),
        )
      } else {
        findings.push(
          makeFinding({
            ruleId: 'empty-anchor-text',
            message: `Anchor from "${anchor.from}" to "${anchor.to}" has no text, no image alt, no aria-label and no title, so it has no accessible name.`,
            file,
            pointer,
            evidence: anchor.to,
            suggestion: 'Give the anchor text that names where the link goes.',
          }),
        )
      }
    } else {
      counts.named += 1
      if (source === 'image-alt' && anchor.hasImage) counts.imageOnlyNamed += 1
    }

    if (context === undefined) {
      if (!undeclaredContexts.has(anchor.context)) {
        undeclaredContexts.set(anchor.context, { count: 0, samples: [], source: anchor.source })
      }
      const entry = undeclaredContexts.get(anchor.context)
      entry.count += 1
      if (entry.samples.length < limits.maxListed) entry.samples.push(anchor.from)
    } else if (context.kind === 'navigation') counts.navigationAnchors += 1
    else counts.editorialAnchors += 1

    if (locale === null) localeless.push(anchor)

    if (declaredTarget === undefined) {
      if (!undeclaredTargets.has(anchor.to)) {
        undeclaredTargets.set(anchor.to, { count: 0, samples: [], source: anchor.source })
      }
      const entry = undeclaredTargets.get(anchor.to)
      entry.count += 1
      if (entry.samples.length < limits.maxListed) entry.samples.push(anchor.from)
    }

    const normalised = name === null ? null : normaliseName(name)

    if (normalised !== null && declaredTarget !== undefined) {
      const owners = nameIndex.get(normalised)
      if (owners !== undefined && !owners.has(anchor.to)) {
        counts.misleading += 1
        const named = [...owners].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
        findings.push(
          makeFinding({
            ruleId: 'misleading-anchor-text',
            message: `Anchor on "${anchor.from}" reads as the declared name of ${listSome(named, limits.maxListed)} but links to "${anchor.to}".`,
            file,
            pointer,
            evidence: name,
            suggestion: 'Point the anchor at the target its text names, or rewrite the text to name this target.',
          }),
        )
      }
    }

    // Scored only when the name, the context kind and the locale are all
    // known. An anchor missing any of them is counted as unscored and has
    // already produced a finding that forces an incomplete report: guessing a
    // context kind would be exactly the "unknown reported as known" defect.
    if (normalised === null || context === undefined || locale === null) {
      counts.unscoredAnchors += 1
      continue
    }

    const groupKey = keyOf([locale, context.kind, anchor.to])
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        locale,
        context: context.kind,
        target: anchor.to,
        variants: new Map(),
      })
    }
    const group = groups.get(groupKey)
    if (!group.variants.has(normalised)) {
      group.variants.set(normalised, {
        name: normalised,
        example: name,
        source,
        count: 0,
        pages: new Set(),
        sources: [],
        first: anchor.source,
      })
    }
    const variant = group.variants.get(normalised)
    variant.count += 1
    variant.pages.add(anchor.from)
    variant.sources.push(anchor.from)

    const nameKey = keyOf([locale, context.kind, normalised])
    if (!nameTargets.has(nameKey)) {
      nameTargets.set(nameKey, {
        locale,
        context: context.kind,
        name: normalised,
        example: name,
        targets: new Set(),
        first: anchor.source,
      })
    }
    nameTargets.get(nameKey).targets.add(anchor.to)
  }

  for (const [contextId, entry] of [...undeclaredContexts.entries()].sort((left, right) =>
    compareParts([left[0]], [right[0]]),
  )) {
    findings.push(
      makeFinding({
        ruleId: 'context-undeclared',
        message: `Context "${contextId}" is used by ${entry.count} anchor(s) but never declared, so those anchors could not be scored as navigation or editorial.`,
        file: entry.source.file,
        pointer: entry.source.pointer,
        evidence: listSome(entry.samples, limits.maxListed, entry.count),
        suggestion: `Declare "${contextId}" in "contexts" with a kind of navigation or editorial.`,
      }),
    )
  }

  for (const [targetId, entry] of [...undeclaredTargets.entries()].sort((left, right) =>
    compareParts([left[0]], [right[0]]),
  )) {
    findings.push(
      makeFinding({
        ruleId: 'target-undeclared',
        message: `Target "${targetId}" is linked from ${entry.count} anchor(s) but is not declared in "targets", so its anchor text could not be compared against its name.`,
        file: entry.source.file,
        pointer: entry.source.pointer,
        evidence: listSome(entry.samples, limits.maxListed, entry.count),
        suggestion: 'Add the target to "targets", or drop the anchors that point at it from the export.',
      }),
    )
  }

  if (localeless.length > 0) {
    findings.push(
      makeFinding({
        ruleId: 'locale-undeclared',
        message: `${localeless.length} anchor(s) have no locale and the export declares no "defaultLocale", so their variants could not be grouped without mixing languages.`,
        file: localeless[0].source.file,
        pointer: localeless[0].source.pointer,
        evidence: listSome(
          localeless.map((anchor) => anchor.from),
          limits.maxListed,
        ),
        suggestion: 'Declare "defaultLocale" in the export, pass --default-locale, or set "locale" on each anchor.',
      }),
    )
  }

  const orderedGroups = [...groups.values()].sort((left, right) =>
    compareParts([left.locale, left.context, left.target], [right.locale, right.context, right.target]),
  )

  const reportedGroups = []
  for (const group of orderedGroups) {
    const variants = [...group.variants.values()].sort((left, right) =>
      compareParts([left.name], [right.name]),
    )
    counts.variants += variants.length

    for (const variant of variants) {
      if (variant.count <= limits.maxEditorialRepeats) continue
      if (group.context === 'editorial') {
        counts.overRepeated += 1
        findings.push(
          makeFinding({
            ruleId: 'over-repeated-anchor-text',
            message: `Editorial anchor text "${variant.name}" points at "${group.target}" ${variant.count} time(s) in locale "${group.locale}", above the ${limits.maxEditorialRepeats} allowed for an editorial context.`,
            file: variant.first.file,
            pointer: variant.first.pointer,
            evidence: listSome([...variant.pages].sort((left, right) => compareParts([left], [right])), limits.maxListed),
            suggestion: 'Vary the wording of the in-body links, or move the repeated link into a declared navigation context.',
          }),
        )
      } else {
        counts.navigationRepeats += 1
        findings.push(
          makeFinding({
            ruleId: 'navigation-repetition-expected',
            message: `Navigation anchor text "${variant.name}" points at "${group.target}" ${variant.count} time(s) in locale "${group.locale}"; repetition in a navigation context is expected and was not counted against the editorial budget.`,
            file: variant.first.file,
            pointer: variant.first.pointer,
            evidence: listSome([...variant.pages].sort((left, right) => compareParts([left], [right])), limits.maxListed),
          }),
        )
      }
    }

    // Grouping, counting and ordering all use the raw ids; only the copies
    // that reach the report are flattened. A locale tag, a target id, an
    // anchor name and a page id are export content, and `groups` carries them
    // into stdout exactly as a finding's message does.
    reportedGroups.push({
      locale: singleLine(group.locale),
      context: group.context,
      target: singleLine(group.target),
      variants: variants.map((variant) => ({
        name: singleLine(variant.name),
        example: singleLine(variant.example),
        nameSource: variant.source,
        count: variant.count,
        pages: variant.pages.size,
        sources: [...variant.sources]
          .sort((left, right) => compareParts([left], [right]))
          .slice(0, limits.maxListed)
          .map((page) => singleLine(page)),
      })),
    })
  }
  counts.groups = reportedGroups.length

  for (const entry of [...nameTargets.values()].sort((left, right) =>
    compareParts([left.locale, left.context, left.name], [right.locale, right.context, right.name]),
  )) {
    if (entry.targets.size < 2) continue
    counts.ambiguous += 1
    const listed = [...entry.targets].sort((left, right) => compareParts([left], [right]))
    findings.push(
      makeFinding({
        ruleId: 'ambiguous-anchor-text',
        message: `Anchor text "${entry.name}" points at ${entry.targets.size} different targets in the ${entry.context} context of locale "${entry.locale}".`,
        file: entry.first.file,
        pointer: entry.first.pointer,
        evidence: listSome(listed, limits.maxListed),
        suggestion: 'Give each target its own anchor text so the text alone says where the link goes.',
      }),
    )
  }

  return { findings, groups: reportedGroups, counts }
}
