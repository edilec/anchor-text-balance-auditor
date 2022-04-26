import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

import { auditExportDocuments, byCodeUnit } from '../src/index.mjs'

/**
 * Ordering is part of the contract: two runs over the same export must produce
 * byte-identical stdout, on any host.
 *
 * Every fixture here is chosen so that UTF-16 code-unit order and ICU
 * collation genuinely DISAGREE, and is declared in the opposite order to the
 * expected one. Swapping any comparator for localeCompare, or deleting any
 * sort, changes the expected arrays below. A sort test whose inputs collate
 * the same way under both rules cannot fail and is not a test.
 */

const run = promisify(execFile)
const CLI = resolve(import.meta.dirname, '..', 'bin', 'anchor-text-balance-auditor.mjs')
const CLEAN = resolve(import.meta.dirname, '..', 'examples', 'site-clean.json')

test('the comparator is code-unit order, which disagrees with collation here', () => {
  assert.equal(byCodeUnit('Zeta.json', 'alpha.json'), -1)
  assert.equal('Zeta.json'.localeCompare('alpha.json') > 0, true)

  assert.equal(byCodeUnit('voir tout', '\u00e0 propos'), -1)
  assert.equal('voir tout'.localeCompare('\u00e0 propos') < 0, false)

  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('findings sort by file, then pointer, then rule id', () => {
  // Declared alpha-first so a missing sort leaves them alpha-first, and
  // collation-first so localeCompare leaves them alpha-first too.
  const report = auditExportDocuments({
    documents: [
      {
        file: 'alpha.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [{ id: 'body', kind: 'editorial' }],
          targets: [{ id: '/docs/', title: 'Documentation' }],
          anchors: [
            { from: '/a', to: '/docs/', context: 'body' },
            { from: '/b', to: '/undeclared', context: 'body', text: 'elsewhere' },
          ],
        },
      },
      {
        file: 'Zeta.json',
        data: {
          schemaVersion: '1',
          anchors: [
            { from: '/c', to: '/docs/', context: 'body', hasImage: true },
            { from: '/d', to: '/docs/', context: 'nowhere', text: 'somewhere' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.location.pointer, finding.ruleId]),
    [
      ['Zeta.json', '/anchors/0', 'image-anchor-unnamed'],
      ['Zeta.json', '/anchors/1', 'context-undeclared'],
      ['alpha.json', '/anchors/0', 'empty-anchor-text'],
      ['alpha.json', '/anchors/1', 'target-undeclared'],
    ],
  )
})

test('two findings on one anchor sort by rule id', () => {
  // One anchor that is BOTH empty AND in a context nobody declared, so both
  // findings land on the same file and the same pointer and the rule id is the
  // only key left to order them. Rule id order and message order disagree
  // here on purpose: "context-undeclared" sorts before "empty-anchor-text",
  // while "Anchor from ..." sorts before "Context ...". A fixture where the
  // two agree cannot fail if the rule id key is deleted.
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [],
          targets: [{ id: '/docs/', title: 'Documentation' }],
          anchors: [{ from: '/a', to: '/docs/', context: 'sidebar' }],
        },
      },
    ],
  })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.pointer, finding.ruleId]),
    [
      ['/anchors/0', 'context-undeclared'],
      ['/anchors/0', 'empty-anchor-text'],
    ],
  )
  assert.equal(report.findings[0].message.startsWith('Context "sidebar"'), true)
  assert.equal(report.findings[1].message.startsWith('Anchor from "/a"'), true)
})

/**
 * Page ids chosen so code-unit order and collation genuinely disagree: by code
 * unit "/Mike" < "/Zulu" < "/alpha" < "/bravo", by collation alpha, bravo,
 * Mike, Zulu. They are declared in collation order, so BOTH substituting a
 * collator and deleting the sort leave them in the declared order and fail.
 */
const SCRAMBLED_PAGES = Object.freeze(['/alpha', '/bravo', '/Mike', '/Zulu'])
const CODE_UNIT_PAGES = '/Mike, /Zulu, /alpha, /bravo'

function repetition(context, kind) {
  return auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [{ id: context, kind }],
          targets: [{ id: '/docs/' }],
          anchors: SCRAMBLED_PAGES.map((page) => ({
            from: page,
            to: '/docs/',
            context,
            text: 'the guide',
          })),
        },
      },
    ],
  })
}

test('an over-repetition lists its pages in code-unit order', () => {
  const report = repetition('body', 'editorial')

  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['over-repeated-anchor-text'],
  )
  assert.equal(report.findings[0].evidence, CODE_UNIT_PAGES)
})

test('an expected navigation repetition lists its pages in the same order', () => {
  const report = repetition('nav', 'navigation')

  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['navigation-repetition-expected'],
  )
  assert.equal(report.findings[0].evidence, CODE_UNIT_PAGES)
})

test('a misleading anchor lists the targets that own its text in code-unit order', () => {
  // "/Zeta" and "/alpha" share the declared title, and are declared in
  // collation order so an unsorted or collated list reads "/alpha, /Zeta".
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [{ id: 'body', kind: 'editorial' }],
          targets: [
            { id: '/alpha', title: 'Pricing' },
            { id: '/Zeta', aliases: ['Pricing'] },
            { id: '/docs/', title: 'Documentation' },
          ],
          anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'Pricing' }],
        },
      },
    ],
  })

  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['misleading-anchor-text'],
  )
  assert.equal(
    report.findings[0].message,
    'Anchor on "/a" reads as the declared name of /Zeta, /alpha but links to "/docs/".',
  )
})

test('an ambiguous anchor text lists its targets in code-unit order', () => {
  // Declared and linked in collation order, expected back in code-unit order.
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [{ id: 'body', kind: 'editorial' }],
          targets: [{ id: '/alpha', title: 'Plans' }, { id: '/Zeta', title: 'Support' }],
          anchors: [
            { from: '/a', to: '/alpha', context: 'body', text: 'learn more' },
            { from: '/b', to: '/Zeta', context: 'body', text: 'learn more' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['ambiguous-anchor-text'],
  )
  assert.equal(report.findings[0].evidence, '/Zeta, /alpha')
})

test('findings about undeclared ids come out in first-use order, not id order', () => {
  // Each of these findings is located at the first anchor that used the id, so
  // the pointer decides their order and "zulu" precedes "Alpha" even though
  // every ordering rule there is would put "Alpha" first. Dropping the pointer
  // key from the finding sort leaves the rule id and then the message, and the
  // message starts with the id.
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [],
          targets: [],
          anchors: [
            { from: '/p', to: '/zulu', context: 'zulu', text: 'one' },
            { from: '/q', to: '/Alpha', context: 'Alpha', text: 'two' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.pointer, finding.ruleId, finding.evidence]),
    [
      ['/anchors/0', 'context-undeclared', '/p'],
      ['/anchors/0', 'target-undeclared', '/p'],
      ['/anchors/1', 'context-undeclared', '/q'],
      ['/anchors/1', 'target-undeclared', '/q'],
    ],
  )
  assert.equal(report.findings[0].message.startsWith('Context "zulu"'), true)
  assert.equal(report.findings[2].message.startsWith('Context "Alpha"'), true)
})

test('groups sort by locale, then context kind, then target', () => {
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          contexts: [
            { id: 'nav', kind: 'navigation' },
            { id: 'body', kind: 'editorial' },
          ],
          targets: [{ id: '/alpha' }, { id: '/Zeta' }],
          anchors: [
            { from: '/p', to: '/alpha', context: 'nav', text: 'alpha', locale: 'en' },
            { from: '/p', to: '/Zeta', context: 'nav', text: 'zeta', locale: 'en' },
            { from: '/p', to: '/alpha', context: 'body', text: 'alpha', locale: 'en' },
            { from: '/p', to: '/alpha', context: 'body', text: 'alpha', locale: 'de' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(
    report.groups.map((group) => [group.locale, group.context, group.target]),
    [
      ['de', 'editorial', '/alpha'],
      ['en', 'editorial', '/alpha'],
      ['en', 'navigation', '/Zeta'],
      ['en', 'navigation', '/alpha'],
    ],
  )
})

test('variants and their source pages sort by code unit, not by collation', () => {
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'fr',
          contexts: [{ id: 'body', kind: 'editorial' }],
          targets: [{ id: '/fr/docs/' }],
          anchors: [
            { from: '/fr/alpha', to: '/fr/docs/', context: 'body', text: '\u00e0 propos' },
            { from: '/fr/Zeta', to: '/fr/docs/', context: 'body', text: 'voir tout' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(
    report.groups[0].variants.map((variant) => [variant.name, variant.sources]),
    [
      ['voir tout', ['/fr/Zeta']],
      ['\u00e0 propos', ['/fr/alpha']],
    ],
  )
})

test('one variant lists its source pages in code-unit order', () => {
  const report = auditExportDocuments({
    documents: [
      {
        file: 'export.json',
        data: {
          schemaVersion: '1',
          defaultLocale: 'en',
          contexts: [{ id: 'body', kind: 'editorial' }],
          targets: [{ id: '/docs/' }],
          anchors: [
            { from: '/alpha', to: '/docs/', context: 'body', text: 'the guide' },
            { from: '/Zeta', to: '/docs/', context: 'body', text: 'the guide' },
          ],
        },
      },
    ],
  })

  assert.deepEqual(report.groups[0].variants[0].sources, ['/Zeta', '/alpha'])
})

test('the same export audited twice produces identical reports', () => {
  const documents = [
    {
      file: 'export.json',
      data: {
        schemaVersion: '1',
        defaultLocale: 'en',
        contexts: [{ id: 'body', kind: 'editorial' }],
        targets: [{ id: '/docs/', title: 'Documentation' }, { id: '/pricing', title: 'Pricing' }],
        anchors: [
          { from: '/a', to: '/docs/', context: 'body', text: 'Pricing' },
          { from: '/b', to: '/docs/', context: 'body' },
          { from: '/c', to: '/docs/', context: 'body', text: 'the guide' },
        ],
      },
    },
  ]

  const first = JSON.stringify(auditExportDocuments({ documents }))
  const second = JSON.stringify(auditExportDocuments({ documents }))

  assert.equal(first, second)
  assert.equal(JSON.parse(first).findings.length, 2)
})

test('two CLI runs over one export write byte-identical stdout', async () => {
  const first = await run(process.execPath, [CLI, '--export', CLEAN, '--json'])
  const second = await run(process.execPath, [CLI, '--export', CLEAN, '--json'])

  assert.equal(first.stdout, second.stdout)
  // Non-trivially identical: the report has content to differ in.
  assert.equal(JSON.parse(first.stdout).summary.checked, 21)
  assert.ok(JSON.parse(first.stdout).groups.length > 1)
})
