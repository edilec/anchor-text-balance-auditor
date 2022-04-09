import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The CLI is the contract most consumers actually see, so it is exercised as a
 * real process: stdout carries the JSON report and nothing else, stderr
 * carries diagnostics, and exit 2 has two distinct shapes. A usage error
 * leaves stdout EMPTY, because the run never had a subject; an input that
 * could not be read prints an "incomplete" report, because the run had a
 * subject and failed to obtain evidence about it.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'anchor-text-balance-auditor.mjs')
const EXAMPLES = resolve(import.meta.dirname, '..', 'examples')

function runCli(args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      resolvePromise({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-cli-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fixture(directory, name, data) {
  const path = join(directory, name)
  await writeFile(path, JSON.stringify(data, null, 2))
  return path
}

test('--help explains the tool and exits 0 without touching stderr', async () => {
  const result = await runCli(['--help'])

  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /Usage:\n {2}anchor-text-balance-auditor --export FILE/)
  assert.match(result.stdout, /--max-editorial-repeats N/)
  assert.match(result.stdout, /Exit codes:/)
})

test('the clean example passes and shows the navigation distinction', async () => {
  const result = await runCli(['--export', join(EXAMPLES, 'site-clean.json')])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /status pass/)
  assert.match(result.stdout, /5 image-only but named/)
  assert.match(result.stdout, /navigation-repetition-expected/)
  assert.equal(result.stdout.includes('over-repeated'), true)
  assert.equal(result.stderr, '')
})

test('the broken example fails with exit 1 and every defect named', async () => {
  const result = await runCli(['--export', join(EXAMPLES, 'site-broken.json'), '--json'])

  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    [
      'ambiguous-anchor-text',
      'empty-anchor-text',
      'image-anchor-unnamed',
      'misleading-anchor-text',
      'over-repeated-anchor-text',
    ],
  )
  assert.equal(report.summary.errors, 4)
  assert.equal(report.summary.imageOnlyNamed, 2)
})

test('the incomplete example exits 2 with a report on stdout and a reason on stderr', async () => {
  const result = await runCli(['--export', join(EXAMPLES, 'site-unknown.json'), '--json'])

  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.match(result.stderr, /the evidence does not support a pass/)
})

test('an unknown option leaves stdout empty: the run never had a subject', async () => {
  const result = await runCli(['--export', join(EXAMPLES, 'site-clean.json'), '--strict'])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--strict"/)
})

test('every usage mistake keeps stdout empty', async (t) => {
  const directory = await workspace(t)
  const good = await fixture(directory, 'export.json', { schemaVersion: '1' })

  const cases = [
    [[], /--export is required/],
    [['--export'], /--export requires a value/],
    [['--export', good, '--max-anchors'], /--max-anchors requires a value/],
    [['--export', good, '--max-anchors', '0'], /positive integer/],
    [['--export', good, '--max-anchors', 'many'], /positive integer/],
    [['--export', good, '--max-listed', '-2'], /--max-listed requires a value/],
    [['--export', good, '--root', join(directory, 'absent')], /root could not be resolved/],
    [['--export', good, '--default-locale', ''], /Default locale must be a non-empty string/],
    [['--export', good, '--default-locale'], /--default-locale requires a value/],
  ]

  for (const [args, expected] of cases) {
    const result = await runCli(args)
    assert.equal(result.code, 2, `${args.join(' ')} did not exit 2`)
    assert.equal(result.stdout, '', `${args.join(' ')} wrote to stdout`)
    assert.match(result.stderr, expected)
  }
})

test('an unreadable input exits 2 with an incomplete report, not an empty stdout', async (t) => {
  const directory = await workspace(t)

  const result = await runCli(['--export', join(directory, 'absent.json'), '--json'])

  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['export-unreadable'],
  )
  // The consumer learns WHICH input was not read, by a path relative to the root.
  assert.equal(report.findings[0].location.file, 'absent.json')
})

test('--json writes a parseable report and nothing else', async () => {
  const result = await runCli(['--export', join(EXAMPLES, 'site-clean.json'), '--json'])

  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'anchor-text-balance-auditor')
  assert.equal(report.status, 'pass')
  assert.equal(result.stdout.endsWith('}\n'), true)
})

test('--default-locale supplies the locale an export never declared', async (t) => {
  const directory = await workspace(t)
  const path = await fixture(directory, 'export.json', {
    schemaVersion: '1',
    contexts: [{ id: 'body', kind: 'editorial' }],
    targets: [{ id: '/docs/', title: 'Documentation' }],
    anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'the documentation' }],
  })

  const without = await runCli(['--export', path, '--json'])
  assert.equal(without.code, 2)
  assert.equal(JSON.parse(without.stdout).status, 'incomplete')

  const withLocale = await runCli(['--export', path, '--default-locale', 'en-GB', '--json'])
  assert.equal(withLocale.code, 0)
  const report = JSON.parse(withLocale.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.groups[0].locale, 'en-GB')
})

test('--max-editorial-repeats reaches the audit from the command line', async () => {
  const strict = await runCli([
    '--export',
    join(EXAMPLES, 'site-broken.json'),
    '--max-editorial-repeats',
    '4',
    '--json',
  ])

  assert.equal(strict.code, 1)
  const ruleIds = JSON.parse(strict.stdout).findings.map((finding) => finding.ruleId)
  assert.equal(ruleIds.includes('over-repeated-anchor-text'), false)
  assert.equal(ruleIds.includes('empty-anchor-text'), true)
})

test('--root confines the run, and a shard outside it is refused by the CLI', async (t) => {
  const directory = await workspace(t)
  const result = await runCli([
    '--export',
    join(EXAMPLES, 'site-clean.json'),
    '--root',
    directory,
    '--json',
  ])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the export root/)
})

test('export content cannot forge a line in the human report', async (t) => {
  const directory = await workspace(t)
  // Ids that try to write their own report lines: a newline plus a severity
  // word, and a U+2028 line separator that several consumers treat as a break.
  const path = await fixture(directory, 'export.json', {
    schemaVersion: '1',
    defaultLocale: 'en',
    contexts: [{ id: 'body', kind: 'editorial' }],
    targets: [{ id: '/docs/', title: 'Documentation' }],
    anchors: [
      { from: '/a\nERROR   forged.json /x forged-rule forged line', to: '/docs/', context: 'body' },
      {
        from: '/b',
        to: '/docs/',
        context: 'promo\u2028ERROR   forged.json /y forged-rule another forged line',
        text: 'the documentation',
      },
    ],
  })

  const human = await runCli(['--export', path])
  const lines = human.stdout.split('\n')
  assert.equal(lines.at(-1), '')
  // Five header lines and exactly one line per finding.
  assert.equal(lines.length - 1, 7)
  assert.equal(lines.filter((line) => line.startsWith('ERROR')).length, 1)
  assert.equal(lines.filter((line) => line.includes('forged-rule')).length, 2)
  assert.equal(human.stdout.includes('\u2028'), false)

  // The JSON report keeps the bytes as they were; JSON escapes them.
  const json = await runCli(['--export', path, '--json'])
  const report = JSON.parse(json.stdout)
  assert.equal(
    report.findings.some((finding) => finding.message.includes('\nERROR')),
    true,
  )
  assert.equal(
    report.findings.some((finding) => finding.message.includes('\u2028')),
    true,
  )
})

test('the packaged bin is executable and self-contained', async () => {
  const { stdout } = await runCli(['--export', join(EXAMPLES, 'anchors', 'blog.json'), '--json'])
  const report = JSON.parse(stdout)

  // A shard on its own declares no contexts or targets, so it is all unknown.
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    ['context-undeclared', 'locale-undeclared', 'target-undeclared'],
  )
})
