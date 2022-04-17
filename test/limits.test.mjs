import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_LIMITS, auditExportDocuments, auditExportFile } from '../src/index.mjs'

/**
 * Every documented limit is enforced here, and every one of them says so when
 * it is hit. A limit that is accepted and then ignored is worse than no limit:
 * it reads like a guarantee while quietly dropping the evidence that would
 * have failed the run. Truncation is never silent.
 */

function data(overrides = {}) {
  return {
    schemaVersion: '1',
    defaultLocale: 'en',
    contexts: [{ id: 'body', kind: 'editorial' }],
    targets: [{ id: '/docs/', title: 'Documentation' }],
    anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'the documentation' }],
    ...overrides,
  }
}

function audit(overrides, limits) {
  return auditExportDocuments({ documents: [{ file: 'export.json', data: data(overrides) }], limits })
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

function anchorsTo(target, count, text = 'the documentation') {
  return Array.from({ length: count }, (unused, index) => ({
    from: `/page-${index}`,
    to: target,
    context: 'body',
    text,
  }))
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-limits-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('maxAnchors drops the excess and names what was not audited', () => {
  const report = audit({ anchors: anchorsTo('/docs/', 3) }, { maxAnchors: 2 })

  assert.ok(ruleIds(report).includes('too-many-anchors'))
  assert.equal(report.summary.checked, 2)
  assert.match(
    report.findings.find((finding) => finding.ruleId === 'too-many-anchors').message,
    /1 anchor\(s\) were not audited/,
  )
  assert.equal(report.status, 'incomplete')
})

test('maxTargets drops the excess, and anchors to a dropped target become unknown', () => {
  const report = audit(
    {
      targets: [{ id: '/docs/' }, { id: '/pricing' }],
      anchors: [{ from: '/a', to: '/pricing', context: 'body', text: 'pricing' }],
    },
    { maxTargets: 1 },
  )

  assert.deepEqual(ruleIds(report).sort(), ['target-undeclared', 'too-many-targets'])
  assert.equal(report.summary.targets, 1)
  assert.equal(report.status, 'incomplete')
})

test('maxContexts drops the excess, and anchors in a dropped context become unknown', () => {
  const report = audit(
    {
      contexts: [
        { id: 'body', kind: 'editorial' },
        { id: 'nav', kind: 'navigation' },
      ],
      anchors: [{ from: '/a', to: '/docs/', context: 'nav', text: 'docs' }],
    },
    { maxContexts: 1 },
  )

  assert.deepEqual(ruleIds(report).sort(), ['context-undeclared', 'too-many-contexts'])
  assert.equal(report.summary.contexts, 1)
  assert.equal(report.status, 'incomplete')
})

test('maxFileBytes is checked before the file is read', async (t) => {
  const directory = await workspace(t)
  const path = join(directory, 'export.json')
  await writeFile(path, JSON.stringify(data()))

  const refused = await auditExportFile({ exportFile: path, limits: { maxFileBytes: 16 } })
  assert.deepEqual(ruleIds(refused), ['file-too-large'])
  assert.match(refused.findings[0].message, /above the 16 byte limit; it was not read/)
  assert.equal(refused.summary.checked, 0)

  const accepted = await auditExportFile({ exportFile: path, limits: { maxFileBytes: 65536 } })
  assert.deepEqual(ruleIds(accepted), [])
  assert.equal(accepted.summary.checked, 1)
})

test('maxIncludeDepth stops the nesting and says which shard was not read', async (t) => {
  const directory = await workspace(t)
  await writeFile(
    join(directory, 'deep.json'),
    JSON.stringify({
      schemaVersion: '1',
      anchors: [{ from: '/deep', to: '/docs/', context: 'body', text: 'deep link' }],
    }),
  )
  await writeFile(join(directory, 'mid.json'), JSON.stringify({ schemaVersion: '1', include: ['deep.json'] }))
  await writeFile(join(directory, 'export.json'), JSON.stringify(data({ include: ['mid.json'] })))

  const stopped = await auditExportFile({
    exportFile: join(directory, 'export.json'),
    limits: { maxIncludeDepth: 1 },
  })
  assert.deepEqual(ruleIds(stopped), ['include-depth-exceeded'])
  assert.equal(stopped.summary.documents, 2)
  assert.equal(stopped.summary.checked, 1)

  const allowed = await auditExportFile({
    exportFile: join(directory, 'export.json'),
    limits: { maxIncludeDepth: 2 },
  })
  assert.deepEqual(ruleIds(allowed), [])
  assert.equal(allowed.summary.documents, 3)
  assert.equal(allowed.summary.checked, 2)
})

test('maxIncludeFiles stops after the allowed shards and reports once', async (t) => {
  const directory = await workspace(t)
  for (const name of ['one.json', 'two.json', 'three.json']) {
    await writeFile(join(directory, name), JSON.stringify({ schemaVersion: '1' }))
  }
  await writeFile(
    join(directory, 'export.json'),
    JSON.stringify(data({ include: ['one.json', 'two.json', 'three.json'] })),
  )

  const report = await auditExportFile({
    exportFile: join(directory, 'export.json'),
    limits: { maxIncludeFiles: 1 },
  })

  assert.deepEqual(ruleIds(report), ['too-many-include-files'])
  assert.equal(report.summary.documents, 2)
})

test('maxListed bounds every list that reaches the output, and says how many it hid', () => {
  const report = audit(
    { anchors: anchorsTo('/undeclared', 5, 'somewhere else') },
    { maxListed: 2, maxEditorialRepeats: 99 },
  )

  const undeclared = report.findings.find((finding) => finding.ruleId === 'target-undeclared')
  assert.equal(undeclared.evidence, '/page-0, /page-1 (+3 more)')
  assert.match(undeclared.message, /linked from 5 anchor\(s\)/)

  // The same bound, on the other finding that samples rather than collects.
  const contexts = audit(
    { anchors: anchorsTo('/docs/', 5).map((anchor) => ({ ...anchor, context: 'promo' })) },
    { maxListed: 2, maxEditorialRepeats: 99 },
  )
  const undeclaredContext = contexts.findings.find((finding) => finding.ruleId === 'context-undeclared')
  assert.equal(undeclaredContext.evidence, '/page-0, /page-1 (+3 more)')
  assert.match(undeclaredContext.message, /used by 5 anchor\(s\)/)

  // The bounded list never shortens the exact count it summarises.
  const variant = report.groups[0].variants[0]
  assert.equal(variant.count, 5)
  assert.equal(variant.pages, 5)
  assert.deepEqual(variant.sources, ['/page-0', '/page-1'])
})

test('maxFindings truncates deterministically and the notice survives the truncation', () => {
  const report = audit(
    {
      anchors: [
        { from: '/a', to: '/docs/', context: 'body' },
        { from: '/b', to: '/docs/', context: 'body' },
        { from: '/c', to: '/docs/', context: 'body' },
      ],
    },
    { maxFindings: 2 },
  )

  assert.equal(report.findings.length, 3)
  assert.deepEqual(ruleIds(report), ['empty-anchor-text', 'empty-anchor-text', 'too-many-findings'])
  assert.match(report.findings[2].message, /1 finding\(s\) were not reported/)
  assert.equal(report.status, 'incomplete')
})

test('maxEditorialRepeats is the editorial budget, and it is wired to the audit', () => {
  const four = anchorsTo('/docs/', 4, 'read the guide')

  assert.deepEqual(ruleIds(audit({ anchors: four }, { maxEditorialRepeats: 4 })), [])
  assert.deepEqual(ruleIds(audit({ anchors: four }, { maxEditorialRepeats: 3 })), [
    'over-repeated-anchor-text',
  ])
  assert.equal(DEFAULT_LIMITS.maxEditorialRepeats, 3)
  assert.deepEqual(ruleIds(audit({ anchors: four })), ['over-repeated-anchor-text'])
})

test('every default limit is a positive integer the audit actually accepts', () => {
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} is ${value}`)
    assert.equal(audit({}, { [name]: value }).status, 'pass')
  }
})
