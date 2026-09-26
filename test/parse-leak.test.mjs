import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseFailureDetail } from '../src/rules.mjs'

/**
 * An export that does not parse is exactly the export whose content is least
 * trustworthy, and V8 hands that content back inside the error message:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. An export
 * short enough to be only a credential is reproduced in full. Interpolating
 * that message into `export-invalid` published it on stdout, in the JSON report
 * a consumer stores and in the human report a build log keeps.
 *
 * Flattening and excerpting do not fix it. `singleLine` replaces control
 * characters and `excerpt` trims from the END, while the quoted span sits at
 * the FRONT of the message and is short enough to survive both.
 *
 * The canary below is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'anchor-text-balance-auditor.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

function runCli(args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      resolvePromise({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-leak-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Every prefix of the canary down to `SHORTEST_PREFIX`, longest first. */
function prefixes() {
  const out = []
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    out.push(CANARY.slice(0, length))
  }
  return out
}

function assertNoCanary(stream, where) {
  for (const prefix of prefixes()) {
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${prefix.length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('an export that is nothing but a credential is not echoed by either report', async (t) => {
  const directory = await workspace(t)
  const path = join(directory, 'export.json')
  await writeFile(path, CANARY)

  for (const args of [[], ['--json']]) {
    const result = await runCli(['--export', path, ...args])
    assert.equal(result.code, 2, 'an unparseable export is incomplete, not a pass')
    assertNoCanary(result.stdout, `stdout for ${JSON.stringify(args)}`)
    assertNoCanary(result.stderr, `stderr for ${JSON.stringify(args)}`)
  }
})

test('a credential sitting inside an unparseable export is not echoed either', async (t) => {
  const directory = await workspace(t)
  const path = join(directory, 'export.json')
  // V8 quotes a WINDOW around the offence, not only the head of the document,
  // so a secret in the middle of a broken export leaks just as readily.
  await writeFile(path, `{"schemaVersion": "1", "key": ${CANARY}}`)

  const result = await runCli(['--export', path, '--json'])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('the finding still says what was wrong and where', async (t) => {
  const directory = await workspace(t)
  const path = join(directory, 'export.json')
  await writeFile(path, '{"schemaVersion": "1" "anchors": []}')

  const report = JSON.parse((await runCli(['--export', path, '--json'])).stdout)
  const finding = report.findings.find((entry) => entry.ruleId === 'export-invalid')
  assert.ok(finding !== undefined, 'the export was refused as invalid JSON')
  // A diagnostic that says nothing is a different defect: position, line and
  // column are V8's useful half and none of them is export content.
  assert.match(finding.message, /at position 22 \(line 1 column 23\)/)
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const cases = [
    // The quoting shape, at the head of the document and inside it.
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    // The position shape, which quotes nothing and is kept whole.
    ['{"a": 1 "b": 2}', "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)"],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a document that merely CONTAINS "at position" does not smuggle itself through', () => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the document supplied that phrase itself.
  const text = `${CANARY} at position 9 (line 1 column 10)`
  try {
    JSON.parse(text)
    assert.fail('supposed to be unparseable')
  } catch (error) {
    const detail = parseFailureDetail(error)
    assert.equal(detail, "unexpected token 'A'")
    assertNoCanary(detail, 'the detail')
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'the export could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'the export could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'the export could not be parsed as JSON')
})

/**
 * The error V8 raises for an export that must not parse, so every case below
 * is pinned against a real message rather than a hand-written one.
 */
function refusal(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return error
  }
  throw new Error(`${JSON.stringify(document)} parsed, so it pins nothing`)
}

/**
 * No prefix of the export four characters or longer survives into the detail.
 * Four rather than the eight `assertNoCanary` uses, because V8 quotes only the
 * first ten characters of a long export: a check for ten would still pass
 * against a detail carrying `AKIA`.
 */
function assertNoPrefixOf(document, detail, label) {
  for (let length = 4; length <= document.length; length += 1) {
    const prefix = document.slice(0, length)
    assert.equal(
      detail.includes(prefix),
      false,
      `${label}: the detail carries ${JSON.stringify(prefix)} -- ${JSON.stringify(detail)}`
    )
  }
}

test('an export whose own text reads "at position 1" is not sliced back out', () => {
  const document = 'at position 1'
  const message = refusal(document).message
  assert.equal(message.includes(document), true, 'V8 no longer quotes the input; this pin needs revisiting')

  const detail = parseFailureDetail(refusal(document))
  assert.equal(detail.includes('"'), false, `a quote means a quoted span survived: ${JSON.stringify(detail)}`)
  assert.equal(detail.includes(document), false, `the export came back out: ${JSON.stringify(detail)}`)
  // Pinned exactly. Recognising the quoting shape first is what makes this both
  // leak-free AND still a diagnostic: an ordering revert that fell back to the
  // generic sentence would hide the same defect behind a passing leak check.
  assert.equal(detail, "unexpected token 'a'")
})

test('a long export whose first ten characters are sensitive keeps none of them', () => {
  // V8 quotes a ten-character prefix once the export is long enough, so the
  // head is exactly the part at risk.
  const document = `${CANARY} and then a great many more characters that never parse`
  const detail = parseFailureDetail(refusal(document))
  assert.equal(detail.includes('"'), false)
  assertNoPrefixOf(document, detail, 'long export')
  assert.equal(detail, "unexpected token 'A'")
})

test('a quoted span carrying a newline is still recognised as a quoted span', () => {
  // The quoting regex needs the `s` flag: without it `.*` stops at the line
  // feed, the shape is missed, and the message falls through to a branch that
  // was never meant to see it.
  const document = '}x\n'
  assert.equal(refusal(document).message.includes('\n'), true, 'the quoted span really does carry the newline')

  const detail = parseFailureDetail(refusal(document))
  assert.equal(detail.includes('"'), false)
  assert.equal(detail.includes('\n'), false)
  assert.equal(detail, "unexpected token '}'")
})

test('the position, line and column survive -- a detail that says nothing is a different defect', () => {
  const detail = parseFailureDetail(refusal('{"schemaVersion": "1" "anchors": []}'))
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)")
  assert.equal(parseFailureDetail(refusal('')), 'Unexpected end of JSON input')
})
