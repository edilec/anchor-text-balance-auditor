import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INCOMPLETE_RULES, RULE_SEVERITY, auditExportDocuments, auditExportFile } from '../src/index.mjs'

/**
 * `status: "incomplete"` is the whole reason this tool can be trusted. Every
 * rule in INCOMPLETE_RULES gets a real scenario here, and each one asserts the
 * STATUS, not just the finding -- so deleting an entry from that list flips the
 * status to "fail" or "pass" and the assertion fails. An invariant that is true
 * only by accident is the defect this file exists to prevent.
 *
 * Four of these rules are warnings. For those, the list is the only thing
 * standing between missing evidence and exit 0, which the last test states
 * outright.
 */

const MINIMAL = {
  schemaVersion: '1',
  defaultLocale: 'en',
  contexts: [{ id: 'body', kind: 'editorial' }],
  targets: [{ id: '/docs/', title: 'Documentation' }],
  anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'the documentation' }],
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-incomplete-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function documents(data, file = 'export.json') {
  return { documents: [{ file, data }] }
}

async function write(directory, name, data) {
  const path = join(directory, name)
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data))
  return path
}

/** One scenario per rule that forces an incomplete report. */
const scenarios = {
  'anchor-name-unresolved': () =>
    auditExportDocuments(
      documents({
        ...MINIMAL,
        anchors: [{ from: '/a', to: '/docs/', context: 'body', labelledBy: 'heading-1' }],
      }),
    ),

  'context-undeclared': () =>
    auditExportDocuments(
      documents({
        ...MINIMAL,
        anchors: [{ from: '/a', to: '/docs/', context: 'sidebar', text: 'the documentation' }],
      }),
    ),

  'empty-export': () => auditExportDocuments(documents({ ...MINIMAL, anchors: [] })),

  'export-invalid': () => auditExportDocuments(documents({ ...MINIMAL, schemaVersion: '9' })),

  'export-undecodable': async (t) => {
    const directory = await workspace(t)
    await writeFile(join(directory, 'export.json'), Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))
    return auditExportFile({ exportFile: join(directory, 'export.json') })
  },

  'export-unreadable': async (t) => {
    const directory = await workspace(t)
    return auditExportFile({ exportFile: join(directory, 'never-written.json') })
  },

  'file-too-large': async (t) => {
    const directory = await workspace(t)
    await write(directory, 'export.json', MINIMAL)
    return auditExportFile({ exportFile: join(directory, 'export.json'), limits: { maxFileBytes: 8 } })
  },

  'include-depth-exceeded': async (t) => {
    const directory = await workspace(t)
    await write(directory, 'deep.json', { schemaVersion: '1' })
    await write(directory, 'mid.json', { schemaVersion: '1', include: ['deep.json'] })
    await write(directory, 'export.json', { ...MINIMAL, include: ['mid.json'] })
    return auditExportFile({
      exportFile: join(directory, 'export.json'),
      limits: { maxIncludeDepth: 1 },
    })
  },

  'locale-undeclared': () => {
    const { defaultLocale, ...withoutLocale } = MINIMAL
    assert.equal(defaultLocale, 'en')
    return auditExportDocuments(documents(withoutLocale))
  },

  'path-escapes-root': async (t) => {
    const directory = await workspace(t)
    const root = join(directory, 'root')
    await mkdir(root)
    await write(directory, 'outside.json', { schemaVersion: '1' })
    await symlink(join(directory, 'outside.json'), join(root, 'shard.json'))
    await write(root, 'export.json', { ...MINIMAL, include: ['shard.json'] })
    return auditExportFile({ exportFile: join(root, 'export.json'), root })
  },

  'target-undeclared': () =>
    auditExportDocuments(
      documents({
        ...MINIMAL,
        anchors: [{ from: '/a', to: '/changelog', context: 'body', text: 'the changelog' }],
      }),
    ),

  'too-many-anchors': () =>
    auditExportDocuments({
      ...documents({
        ...MINIMAL,
        anchors: [
          { from: '/a', to: '/docs/', context: 'body', text: 'the documentation' },
          { from: '/b', to: '/docs/', context: 'body', text: 'our documentation' },
        ],
      }),
      limits: { maxAnchors: 1 },
    }),

  'too-many-contexts': () =>
    auditExportDocuments({
      ...documents({
        ...MINIMAL,
        contexts: [
          { id: 'body', kind: 'editorial' },
          { id: 'nav', kind: 'navigation' },
        ],
      }),
      limits: { maxContexts: 1 },
    }),

  'too-many-findings': () =>
    auditExportDocuments({
      ...documents({
        ...MINIMAL,
        anchors: [
          { from: '/a', to: '/docs/', context: 'body' },
          { from: '/b', to: '/docs/', context: 'body' },
        ],
      }),
      limits: { maxFindings: 1 },
    }),

  'too-many-include-files': async (t) => {
    const directory = await workspace(t)
    await write(directory, 'one.json', { schemaVersion: '1' })
    await write(directory, 'two.json', { schemaVersion: '1' })
    await write(directory, 'export.json', { ...MINIMAL, include: ['one.json', 'two.json'] })
    return auditExportFile({
      exportFile: join(directory, 'export.json'),
      limits: { maxIncludeFiles: 1 },
    })
  },

  'too-many-targets': () =>
    auditExportDocuments({
      ...documents({
        ...MINIMAL,
        targets: [
          { id: '/docs/', title: 'Documentation' },
          { id: '/pricing', title: 'Pricing' },
        ],
      }),
      limits: { maxTargets: 1 },
    }),

  'unsafe-include-path': async (t) => {
    const directory = await workspace(t)
    await write(directory, 'export.json', { ...MINIMAL, include: ['../outside.json'] })
    return auditExportFile({ exportFile: join(directory, 'export.json') })
  },
}

for (const ruleId of INCOMPLETE_RULES) {
  test(`${ruleId} forces an incomplete report`, async (t) => {
    const scenario = scenarios[ruleId]
    assert.equal(typeof scenario, 'function', `no scenario covers ${ruleId}`)

    const report = await scenario(t)
    const ids = report.findings.map((finding) => finding.ruleId)

    assert.ok(ids.includes(ruleId), `expected ${ruleId}, got ${ids.join(', ') || 'nothing'}`)
    // Not just the finding: the STATUS. Removing this rule from
    // INCOMPLETE_RULES turns this into "fail" or "pass" and fails here.
    assert.equal(report.status, 'incomplete')
  })
}

test('every rule that forces incompleteness has a scenario, and no scenario is stale', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), [...INCOMPLETE_RULES].sort())
})

test('the four warning-only rules are the whole reason those runs are not a pass', async (t) => {
  const warningOnly = INCOMPLETE_RULES.filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')
  assert.deepEqual(warningOnly, [
    'anchor-name-unresolved',
    'context-undeclared',
    'locale-undeclared',
    'target-undeclared',
  ])

  for (const ruleId of warningOnly) {
    const report = await scenarios[ruleId](t)
    assert.equal(report.summary.errors, 0, `${ruleId} scenario has an error to hide behind`)
    assert.ok(report.summary.warnings > 0)
    assert.equal(report.status, 'incomplete', `${ruleId} would otherwise be a green run`)
  }
})

test('a run with anchors, no missing evidence and no defect is the only way to pass', () => {
  const report = auditExportDocuments(documents(MINIMAL))

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('pass with nothing checked is unreachable: the empty run reports it instead', () => {
  const report = auditExportDocuments(documents({ ...MINIMAL, anchors: [] }))

  assert.equal(report.summary.checked, 0)
  assert.notEqual(report.status, 'pass')
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['empty-export'],
  )

  const noDocuments = auditExportDocuments({ documents: [] })
  assert.equal(noDocuments.summary.checked, 0)
  assert.equal(noDocuments.status, 'incomplete')
})
