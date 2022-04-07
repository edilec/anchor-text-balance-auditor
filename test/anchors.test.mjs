import assert from 'node:assert/strict'
import test from 'node:test'

import { accessibleName, auditExportDocuments, normaliseName } from '../src/index.mjs'

/**
 * The accessible name is where this tool's two easiest false positives live.
 *
 * An image-only anchor with alt text is NAMED: its accessible name is the alt
 * text, and reporting it as empty would be a false refusal -- a bug exactly as
 * real as a missed defect. An anchor named through aria-labelledby is UNKNOWN:
 * the export does not carry the elements the name is built from, so it is
 * neither named nor empty and the run cannot pass on it.
 */

function documentWith(anchors, overrides = {}) {
  return {
    schemaVersion: '1',
    defaultLocale: 'en',
    contexts: [{ id: 'body', kind: 'editorial' }],
    targets: [{ id: '/docs/', title: 'Documentation' }],
    anchors,
    ...overrides,
  }
}

function audit(anchors, overrides = {}) {
  return auditExportDocuments({
    documents: [{ file: 'export.json', data: documentWith(anchors, overrides) }],
  })
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

const base = { from: '/a', to: '/docs/', context: 'body' }

test('an image-only anchor with alt text is named, not empty', () => {
  const report = audit([{ ...base, hasImage: true, imageAlt: 'Read the documentation' }])

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.summary.named, 1)
  assert.equal(report.summary.unnamed, 0)
  assert.equal(report.summary.imageOnlyNamed, 1)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.groups[0].variants[0].name, 'read the documentation')
  assert.equal(report.groups[0].variants[0].nameSource, 'image-alt')
})

test('an image anchor with no alt and no text has no accessible name', () => {
  const report = audit([{ ...base, hasImage: true }])

  assert.deepEqual(ruleIds(report), ['image-anchor-unnamed'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.summary.unnamed, 1)
  assert.equal(report.summary.imageOnlyNamed, 0)
  assert.equal(report.status, 'fail')
  assert.match(report.findings[0].message, /no alt and no other text/)
})

test('an image anchor with an explicitly empty alt and no text has no accessible name', () => {
  const report = audit([{ ...base, hasImage: true, imageAlt: '' }])

  assert.deepEqual(ruleIds(report), ['image-anchor-unnamed'])
  assert.match(report.findings[0].message, /alt is empty/)
  assert.equal(report.status, 'fail')
})

test('an anchor with nothing at all is an empty anchor, reported under its own rule', () => {
  const report = audit([base])

  assert.deepEqual(ruleIds(report), ['empty-anchor-text'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.summary.unnamed, 1)
})

test('whitespace-only text is not a name', () => {
  const spaces = audit([{ ...base, text: '   \t  ' }])
  assert.deepEqual(ruleIds(spaces), ['empty-anchor-text'])

  const withImage = audit([{ ...base, text: ' ', hasImage: true, imageAlt: '  ' }])
  assert.deepEqual(ruleIds(withImage), ['image-anchor-unnamed'])
})

test('an image anchor that also has text is named by both parts, in one variant', () => {
  const report = audit([{ ...base, text: 'Read', hasImage: true, imageAlt: 'the documentation' }])

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.groups[0].variants[0].nameSource, 'text+image-alt')
  assert.equal(report.groups[0].variants[0].name, 'read the documentation')
  // It is named by its content, not by being image-only.
  assert.equal(report.summary.imageOnlyNamed, 0)
})

test('aria-label wins over content, and an empty aria-label falls through to it', () => {
  assert.deepEqual(accessibleName({ ariaLabel: 'Open the docs', text: 'here' }), {
    name: 'Open the docs',
    source: 'aria-label',
  })
  assert.deepEqual(accessibleName({ ariaLabel: '   ', text: 'here' }), {
    name: 'here',
    source: 'text',
  })
  assert.deepEqual(accessibleName({ ariaLabel: '', hasImage: true, imageAlt: 'Home' }), {
    name: 'Home',
    source: 'image-alt',
  })
})

test('title names an anchor only when nothing else does', () => {
  assert.deepEqual(accessibleName({ title: 'Documentation', text: 'here' }), {
    name: 'here',
    source: 'text',
  })
  assert.deepEqual(accessibleName({ title: 'Documentation' }), {
    name: 'Documentation',
    source: 'title',
  })
  assert.deepEqual(accessibleName({ title: '  ' }), { name: null, source: 'none' })
})

test('an aria-labelledby anchor is unresolved: not named, not empty, and never a pass', () => {
  const report = audit([{ ...base, labelledBy: 'heading-2 note-7' }])

  assert.deepEqual(ruleIds(report), ['anchor-name-unresolved'])
  assert.equal(report.summary.unresolvedNames, 1)
  assert.equal(report.summary.named, 0)
  assert.equal(report.summary.unnamed, 0)
  assert.equal(report.summary.errors, 0)
  // The only thing standing between this missing evidence and a green run.
  assert.equal(report.status, 'incomplete')
})

test('an unresolved name is unknown even when the anchor also carries text', () => {
  // A browser would use the labelledby elements, which the export does not
  // carry, so the recorded text is not the name and must not be audited as it.
  const report = audit([{ ...base, labelledBy: 'heading-2', text: 'Pricing' }])

  assert.deepEqual(ruleIds(report), ['anchor-name-unresolved'])
  assert.equal(report.summary.variants, 0)
  assert.equal(report.summary.unscoredAnchors, 1)
})

test('a blank labelledBy is not a labelledby at all', () => {
  assert.deepEqual(accessibleName({ labelledBy: '   ', text: 'Docs' }), {
    name: 'Docs',
    source: 'text',
  })
})

test('names are folded for grouping without locale-dependent case rules', () => {
  assert.equal(normaliseName('  Read   the\nGuide '), 'read the guide')
  assert.equal(normaliseName('READ THE GUIDE'), normaliseName('read the guide'))
  assert.notEqual(normaliseName('read the guides'), normaliseName('read the guide'))
  // toLocaleLowerCase would map I to a dotless i under a Turkish host locale;
  // toLowerCase does not, so two hosts group the same export identically.
  assert.equal(normaliseName('INDEX'), 'index')
})

test('an anchor is placed in exactly one variant per target, context and locale', () => {
  const report = audit([
    { ...base, text: 'Read the guide' },
    { ...base, from: '/b', text: 'read  the guide' },
    { ...base, from: '/c', text: 'The guide' },
  ])

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.groups.length, 1)
  assert.deepEqual(
    report.groups[0].variants.map((variant) => [variant.name, variant.count, variant.pages]),
    [
      ['read the guide', 2, 2],
      ['the guide', 1, 1],
    ],
  )
})
