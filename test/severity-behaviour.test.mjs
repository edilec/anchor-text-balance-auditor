import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

/**
 * Severity pinned by what the tool DOES, not by what three files say.
 *
 * `test/severity-table.test.mjs` asserts the frozen table against the
 * documented catalog, which is worth having and is not enough on its own: a
 * table entry, a catalog row and a hand-written expectation can all be flipped
 * in one edit and agree with each other perfectly while the tool quietly stops
 * failing on a defect it used to fail on.
 *
 * So every rule is driven through the CLI -- a real export, a real process --
 * and the two things a consumer actually reads are asserted as literals: the
 * report's `status` and the exit code. Downgrading `empty-anchor-text` to a
 * warning makes this file fail with "expected fail, got pass" no matter how
 * many declarations were edited to match, because the observable outcome is
 * what changed.
 *
 * The three shapes, and why each rule has the one it has:
 *
 *   fail / 1        an error that is not missing evidence: the export was
 *                   read, understood, and found defective
 *   incomplete / 2  evidence the run never obtained. Outranks fail: an
 *                   error-severity rule that is also in INCOMPLETE_RULES exits
 *                   2, because a report that could not see everything cannot
 *                   report a verdict on everything
 *   pass / 0        a warning or an info finding, alone. A tool that exits
 *                   non-zero on expected navigation repetition is a tool
 *                   nobody can put in CI
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'anchor-text-balance-auditor.mjs')

const MINIMAL = {
  schemaVersion: '1',
  defaultLocale: 'en',
  contexts: [{ id: 'body', kind: 'editorial' }],
  targets: [{ id: '/docs/', title: 'Documentation' }],
  anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'the documentation' }],
}

function runCli(args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      resolvePromise({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-severity-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function write(directory, name, data) {
  const path = join(directory, name)
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data))
  return path
}

function repeat(times, context, text = 'read the guide') {
  return Array.from({ length: times }, (unused, index) => ({
    from: `/page-${index}`,
    to: '/docs/',
    context,
    text,
  }))
}

/** One real CLI invocation per rule, each producing that rule. */
const scenarios = {
  'ambiguous-anchor-text': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      targets: [
        { id: '/docs/', title: 'Documentation' },
        { id: '/support', title: 'Support' },
      ],
      anchors: [
        { from: '/a', to: '/docs/', context: 'body', text: 'learn more' },
        { from: '/b', to: '/support', context: 'body', text: 'learn more' },
      ],
    }),
  ],

  'anchor-name-unresolved': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/docs/', context: 'body', labelledBy: 'heading-1' }],
    }),
  ],

  'context-undeclared': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/docs/', context: 'sidebar', text: 'the documentation' }],
    }),
  ],

  'duplicate-include': async (directory) => {
    await write(directory, 'shard.json', { schemaVersion: '1' })
    return [await write(directory, 'export.json', { ...MINIMAL, include: ['shard.json', 'shard.json'] })]
  },

  'empty-anchor-text': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/docs/', context: 'body' }],
    }),
  ],

  'empty-export': async (directory) => [
    await write(directory, 'export.json', { ...MINIMAL, anchors: [] }),
  ],

  'export-invalid': async (directory) => [
    await write(directory, 'export.json', { ...MINIMAL, schemaVersion: '9' }),
  ],

  'export-undecodable': async (directory) => {
    const path = join(directory, 'export.json')
    await writeFile(path, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))
    return [path]
  },

  'export-unreadable': async (directory) => [join(directory, 'never-written.json')],

  'file-too-large': async (directory) => [
    await write(directory, 'export.json', MINIMAL),
    '--max-file-bytes',
    '8',
  ],

  'image-anchor-unnamed': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/docs/', context: 'body', hasImage: true }],
    }),
  ],

  'include-depth-exceeded': async (directory) => {
    await write(directory, 'deep.json', { schemaVersion: '1' })
    await write(directory, 'mid.json', { schemaVersion: '1', include: ['deep.json'] })
    return [
      await write(directory, 'export.json', { ...MINIMAL, include: ['mid.json'] }),
      '--max-include-depth',
      '1',
    ]
  },

  'locale-undeclared': async (directory) => {
    const { defaultLocale, ...withoutLocale } = MINIMAL
    assert.equal(defaultLocale, 'en')
    return [await write(directory, 'export.json', withoutLocale)]
  },

  'misleading-anchor-text': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      targets: [
        { id: '/docs/', title: 'Documentation' },
        { id: '/pricing', title: 'Pricing' },
      ],
      anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'Pricing' }],
    }),
  ],

  'navigation-repetition-expected': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      contexts: [{ id: 'nav', kind: 'navigation' }],
      anchors: repeat(4, 'nav'),
    }),
  ],

  'over-repeated-anchor-text': async (directory) => [
    await write(directory, 'export.json', { ...MINIMAL, anchors: repeat(4, 'body') }),
  ],

  'path-escapes-root': async (directory) => {
    const root = join(directory, 'root')
    await mkdir(root)
    await write(directory, 'outside.json', { schemaVersion: '1' })
    await symlink(join(directory, 'outside.json'), join(root, 'shard.json'))
    return [
      await write(root, 'export.json', { ...MINIMAL, include: ['shard.json'] }),
      '--root',
      root,
    ]
  },

  'target-undeclared': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/changelog', context: 'body', text: 'the changelog' }],
    }),
  ],

  'too-many-anchors': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: repeat(2, 'body', 'the documentation'),
    }),
    '--max-anchors',
    '1',
  ],

  'too-many-contexts': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      contexts: [
        { id: 'body', kind: 'editorial' },
        { id: 'nav', kind: 'navigation' },
      ],
    }),
    '--max-contexts',
    '1',
  ],

  'too-many-findings': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      anchors: [
        { from: '/a', to: '/docs/', context: 'body' },
        { from: '/b', to: '/docs/', context: 'body' },
      ],
    }),
    '--max-findings',
    '1',
  ],

  'too-many-include-files': async (directory) => {
    await write(directory, 'one.json', { schemaVersion: '1' })
    await write(directory, 'two.json', { schemaVersion: '1' })
    return [
      await write(directory, 'export.json', { ...MINIMAL, include: ['one.json', 'two.json'] }),
      '--max-include-files',
      '1',
    ]
  },

  'too-many-targets': async (directory) => [
    await write(directory, 'export.json', {
      ...MINIMAL,
      targets: [
        { id: '/docs/', title: 'Documentation' },
        { id: '/pricing', title: 'Pricing' },
      ],
    }),
    '--max-targets',
    '1',
  ],

  'unsafe-include-path': async (directory) => [
    await write(directory, 'export.json', { ...MINIMAL, include: ['../outside.json'] }),
  ],
}

/**
 * What each rule must DO, as literals.
 *
 * These are not derived from RULE_SEVERITY or INCOMPLETE_RULES on purpose:
 * deriving them would let one edit move the table and the expectation
 * together. Changing any line here is changing what the tool promises a
 * consumer, and it is meant to read that way.
 */
const EXPECTED = Object.freeze({
  'ambiguous-anchor-text': { status: 'pass', code: 0 },
  'anchor-name-unresolved': { status: 'incomplete', code: 2 },
  'context-undeclared': { status: 'incomplete', code: 2 },
  'duplicate-include': { status: 'pass', code: 0 },
  'empty-anchor-text': { status: 'fail', code: 1 },
  'empty-export': { status: 'incomplete', code: 2 },
  'export-invalid': { status: 'incomplete', code: 2 },
  'export-undecodable': { status: 'incomplete', code: 2 },
  'export-unreadable': { status: 'incomplete', code: 2 },
  'file-too-large': { status: 'incomplete', code: 2 },
  'image-anchor-unnamed': { status: 'fail', code: 1 },
  'include-depth-exceeded': { status: 'incomplete', code: 2 },
  'locale-undeclared': { status: 'incomplete', code: 2 },
  'misleading-anchor-text': { status: 'fail', code: 1 },
  'navigation-repetition-expected': { status: 'pass', code: 0 },
  'over-repeated-anchor-text': { status: 'pass', code: 0 },
  'path-escapes-root': { status: 'incomplete', code: 2 },
  'target-undeclared': { status: 'incomplete', code: 2 },
  'too-many-anchors': { status: 'incomplete', code: 2 },
  'too-many-contexts': { status: 'incomplete', code: 2 },
  'too-many-findings': { status: 'incomplete', code: 2 },
  'too-many-include-files': { status: 'incomplete', code: 2 },
  'too-many-targets': { status: 'incomplete', code: 2 },
  'unsafe-include-path': { status: 'incomplete', code: 2 },
})

for (const [ruleId, expected] of Object.entries(EXPECTED)) {
  test(`${ruleId} makes a real run ${expected.status} and exit ${expected.code}`, async (t) => {
    const directory = await workspace(t)
    const args = await scenarios[ruleId](directory)

    const result = await runCli(['--export', ...args, '--json'])
    const report = JSON.parse(result.stdout)

    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `${ruleId} was not raised; got ${report.findings.map((finding) => finding.ruleId).join(', ') || 'nothing'}`,
    )
    assert.equal(report.status, expected.status, `${ruleId} produced status ${report.status}`)
    assert.equal(result.code, expected.code, `${ruleId} exited ${result.code}`)

    if (expected.code === 2) assert.match(result.stderr, /the evidence does not support a pass/)
    else assert.equal(result.stderr, '', `${ruleId} wrote to stderr on a ${expected.status}`)
  })
}

test('every rule in the table is pinned by a real run, and no expectation is stale', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(RULE_SEVERITY).sort())
  assert.deepEqual(Object.keys(scenarios).sort(), Object.keys(RULE_SEVERITY).sort())
})

test('the pinned outcomes are the ones the table and the incomplete list imply', () => {
  // The table stays the single source of truth, so the two must agree -- but
  // this is the weaker half of the file. It is the assertions above, on a real
  // exit code, that a coordinated edit cannot satisfy.
  for (const [ruleId, expected] of Object.entries(EXPECTED)) {
    const implied = INCOMPLETE_RULES.includes(ruleId)
      ? 'incomplete'
      : RULE_SEVERITY[ruleId] === 'error'
        ? 'fail'
        : 'pass'
    assert.equal(expected.status, implied, `${ruleId} is pinned as ${expected.status}`)
    assert.equal(expected.code, { pass: 0, fail: 1, incomplete: 2 }[implied])
  }
})

test('an error-severity rule that is also missing evidence exits 2, not 1', () => {
  // The exit-code tables say row 1 is "at least one error-severity finding and
  // nothing missing", because incomplete outranks fail. export-invalid is the
  // proof: severity error, exit 2.
  assert.equal(RULE_SEVERITY['export-invalid'], 'error')
  assert.equal(EXPECTED['export-invalid'].code, 2)
  assert.equal(EXPECTED['empty-anchor-text'].code, 1)
  assert.equal(INCOMPLETE_RULES.includes('empty-anchor-text'), false)
})
