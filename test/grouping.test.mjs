import assert from 'node:assert/strict'
import test from 'node:test'

import { auditExportDocuments } from '../src/index.mjs'

/**
 * Repetition is only meaningful against a context. A "Documentation" link in
 * every header is the site working as designed; the same wording used over and
 * over inside prose is what an editor wants to see. These tests hold the two
 * apart with identical anchor data, so a change that collapses the distinction
 * -- dropping the context kind from the grouping key, scoring navigation
 * against the editorial budget -- cannot stay green.
 */

function report({ anchors, contexts, targets, defaultLocale = 'en', limits }) {
  return auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale,
          contexts: contexts ?? [
            { id: 'nav', kind: 'navigation' },
            { id: 'body', kind: 'editorial' },
          ],
          targets: targets ?? [{ id: '/docs/', title: 'Documentation' }],
          anchors,
        },
      },
    ],
    limits,
  })
}

function ruleIds(result) {
  return result.findings.map((finding) => finding.ruleId)
}

function repeated(context, times, overrides = {}) {
  return Array.from({ length: times }, (unused, index) => ({
    from: `/page-${index}`,
    to: '/docs/',
    context,
    text: 'Read the guide',
    ...overrides,
  }))
}

test('four identical navigation anchors are expected repetition, not a defect', () => {
  const result = report({ anchors: repeated('nav', 4) })

  assert.deepEqual(ruleIds(result), ['navigation-repetition-expected'])
  assert.equal(result.findings[0].severity, 'info')
  assert.equal(result.summary.overRepeated, 0)
  assert.equal(result.summary.navigationRepeats, 1)
  assert.equal(result.summary.navigationAnchors, 4)
  assert.equal(result.status, 'pass')
})

test('the same four anchors in an editorial context are reported for review', () => {
  const result = report({ anchors: repeated('body', 4) })

  assert.deepEqual(ruleIds(result), ['over-repeated-anchor-text'])
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(result.summary.overRepeated, 1)
  assert.equal(result.summary.navigationRepeats, 0)
  assert.equal(result.summary.editorialAnchors, 4)
  assert.match(result.findings[0].message, /above the 3 allowed/)
})

test('navigation repetition is not merged into the editorial count', () => {
  // Three editorial plus three navigation uses of one wording: neither side is
  // over its budget, and a grouping key that ignored the context kind would
  // see six and report one.
  const result = report({
    anchors: [...repeated('body', 3), ...repeated('nav', 3).map((anchor, index) => ({ ...anchor, from: `/nav-${index}` }))],
  })

  assert.deepEqual(ruleIds(result), [])
  assert.equal(result.summary.groups, 2)
  assert.deepEqual(
    result.groups.map((group) => [group.context, group.variants[0].count]),
    [
      ['editorial', 3],
      ['navigation', 3],
    ],
  )
})

test('the editorial repetition budget is a boundary, and it is configurable', () => {
  assert.deepEqual(ruleIds(report({ anchors: repeated('body', 3) })), [])
  assert.deepEqual(ruleIds(report({ anchors: repeated('body', 4) })), ['over-repeated-anchor-text'])

  assert.deepEqual(ruleIds(report({ anchors: repeated('body', 4), limits: { maxEditorialRepeats: 4 } })), [])
  assert.deepEqual(ruleIds(report({ anchors: repeated('body', 3), limits: { maxEditorialRepeats: 2 } })), [
    'over-repeated-anchor-text',
  ])
})

test('locales are scored apart, so a translation is not repetition', () => {
  const result = report({
    anchors: [
      ...repeated('body', 3).map((anchor) => ({ ...anchor, locale: 'en' })),
      ...repeated('body', 3).map((anchor, index) => ({
        ...anchor,
        from: `/fr/page-${index}`,
        locale: 'fr',
      })),
    ],
  })

  assert.deepEqual(ruleIds(result), [])
  assert.deepEqual(
    result.groups.map((group) => [group.locale, group.variants[0].count]),
    [
      ['en', 3],
      ['fr', 3],
    ],
  )
})

test('targets are scored apart: the same wording to two pages is ambiguous, not repeated', () => {
  const result = report({
    targets: [
      { id: '/docs/', title: 'Documentation' },
      { id: '/support', title: 'Support' },
    ],
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'learn more' },
      { from: '/b', to: '/support', context: 'body', text: 'Learn More' },
    ],
  })

  assert.deepEqual(ruleIds(result), ['ambiguous-anchor-text'])
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(result.summary.ambiguous, 1)
  assert.equal(result.summary.overRepeated, 0)
  assert.equal(result.findings[0].evidence, '/docs/, /support')
})

test('the same wording for two targets in two different locales is not ambiguous', () => {
  const result = report({
    targets: [
      { id: '/docs/', title: 'Documentation' },
      { id: '/fr/docs/', title: 'Documentation francaise' },
    ],
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'learn more', locale: 'en' },
      { from: '/fr/a', to: '/fr/docs/', context: 'body', text: 'learn more', locale: 'fr' },
    ],
  })

  assert.deepEqual(ruleIds(result), [])
  assert.equal(result.summary.ambiguous, 0)
})

test('anchor text that names a different declared target is misleading', () => {
  const result = report({
    targets: [
      { id: '/docs/', title: 'Documentation' },
      { id: '/pricing', title: 'Pricing' },
    ],
    anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'Pricing' }],
  })

  assert.deepEqual(ruleIds(result), ['misleading-anchor-text'])
  assert.equal(result.findings[0].severity, 'error')
  assert.equal(result.status, 'fail')
  assert.match(result.findings[0].message, /declared name of \/pricing but links to "\/docs\/"/)
  assert.equal(result.findings[0].evidence, 'Pricing')
})

test('anchor text that names its own target, by title or alias, is not misleading', () => {
  const result = report({
    targets: [
      { id: '/docs/', title: 'Documentation', aliases: ['Docs', 'the reference'] },
      { id: '/pricing', title: 'Pricing' },
    ],
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'Documentation' },
      { from: '/b', to: '/docs/', context: 'body', text: 'docs' },
      { from: '/c', to: '/docs/', context: 'body', text: 'The Reference' },
      { from: '/d', to: '/docs/', context: 'body', text: 'a guide we wrote' },
    ],
  })

  assert.deepEqual(ruleIds(result), [])
  assert.equal(result.summary.misleading, 0)
})

test('misleading is never a judgement of writing: an undeclared name is no evidence', () => {
  const result = report({
    targets: [{ id: '/docs/', title: 'Documentation' }, { id: '/pricing' }],
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'click here' },
      { from: '/b', to: '/docs/', context: 'body', text: 'this thing over here' },
    ],
  })

  assert.deepEqual(ruleIds(result), [])
})

test('a name shared by two declared targets does not make either anchor misleading', () => {
  const result = report({
    targets: [
      { id: '/docs/', title: 'Guide' },
      { id: '/guide', title: 'Guide' },
    ],
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'Guide' },
      { from: '/b', to: '/guide', context: 'body', text: 'Guide' },
    ],
  })

  assert.deepEqual(ruleIds(result), ['ambiguous-anchor-text'])
  assert.equal(result.summary.misleading, 0)
})

test('groups carry the variants, their exact counts and their distinct pages', () => {
  const result = report({
    anchors: [
      { from: '/a', to: '/docs/', context: 'body', text: 'the guide' },
      { from: '/a', to: '/docs/', context: 'body', text: 'the guide' },
      { from: '/b', to: '/docs/', context: 'body', text: 'our guide' },
    ],
  })

  assert.deepEqual(result.groups, [
    {
      locale: 'en',
      context: 'editorial',
      target: '/docs/',
      variants: [
        {
          name: 'our guide',
          example: 'our guide',
          nameSource: 'text',
          count: 1,
          pages: 1,
          sources: ['/b'],
        },
        {
          name: 'the guide',
          example: 'the guide',
          nameSource: 'text',
          count: 2,
          pages: 1,
          sources: ['/a', '/a'],
        },
      ],
    },
  ])
  assert.equal(result.summary.variants, 2)
})
