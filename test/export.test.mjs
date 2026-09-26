import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  auditExportDocuments,
  auditExportFile,
  isInside,
  unsafeIncludeReason,
  validateDocument,
} from '../src/index.mjs'

/**
 * Reading an export is a trust boundary. The document is machine-produced data
 * with no authority to change what the tool does, its bytes may not be UTF-8 at
 * all, and a shard path it names may point anywhere the filesystem allows.
 *
 * Confinement is asserted on REAL paths on BOTH sides. The two failure modes
 * are tested together on purpose: a symlink that escapes the root must be
 * refused, and a file genuinely inside a symlinked root must be accepted. A
 * false refusal is a bug exactly as real as a false acceptance.
 */

const MINIMAL = {
  schemaVersion: '1',
  defaultLocale: 'en',
  contexts: [{ id: 'body', kind: 'editorial' }],
  targets: [{ id: '/docs/', title: 'Documentation' }],
  anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'the documentation' }],
}

function audit(data, file = 'export.json') {
  return auditExportDocuments({ documents: [{ file, data }] })
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anchor-export-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('a document that is not an object, or carries the wrong schema, is refused', () => {
  assert.equal(validateDocument([], 'x.json').ruleId, 'export-invalid')
  assert.equal(validateDocument(null, 'x.json').ruleId, 'export-invalid')
  assert.equal(validateDocument({ schemaVersion: 1 }, 'x.json').location.pointer, '/schemaVersion')
  assert.equal(validateDocument({ ...MINIMAL, schemaVersion: '2' }, 'x.json').ruleId, 'export-invalid')
  assert.equal(validateDocument(MINIMAL, 'x.json'), null)
})

test('an unrecognised key is refused everywhere, so a typo cannot turn a failure green', () => {
  const cases = [
    [{ ...MINIMAL, anchros: [] }, '/anchros'],
    [{ ...MINIMAL, contexts: [{ id: 'body', kind: 'editorial', kidn: 'x' }] }, '/contexts/0'],
    [{ ...MINIMAL, targets: [{ id: '/docs/', titel: 'Documentation' }] }, '/targets/0'],
    [{ ...MINIMAL, anchors: [{ from: '/a', to: '/b', context: 'body', txet: 'hi' }] }, '/anchors/0'],
  ]
  for (const [data, pointer] of cases) {
    const finding = validateDocument(data, 'x.json')
    assert.equal(finding?.ruleId, 'export-invalid', `${pointer} was accepted`)
    assert.equal(finding.location.pointer, pointer)
  }

  // The same typo, seen through the whole audit: refused, and never a pass.
  const report = audit({ ...MINIMAL, anchors: [{ from: '/a', to: '/b', context: 'body', txet: 'hi' }] })
  assert.deepEqual(ruleIds(report), ['export-invalid'])
  assert.equal(report.status, 'incomplete')
})

test('anchor records must be complete and internally consistent', () => {
  const bad = [
    [{ to: '/b', context: 'body' }, /missing its "from"/],
    [{ from: '/a', context: 'body' }, /missing its "to"/],
    [{ from: '/a', to: '/b' }, /missing its "context"/],
    [{ from: '', to: '/b', context: 'body' }, /empty "from"/],
    [{ from: '/a', to: '/b', context: 'body', text: 7 }, /non-string "text"/],
    [{ from: '/a', to: '/b', context: 'body', hasImage: 'yes' }, /"hasImage" must be a boolean/],
    [{ from: '/a', to: '/b', context: 'body', locale: '' }, /"locale" must be a non-empty string/],
    [{ from: '/a', to: '/b', context: 'body', imageAlt: 'Home' }, /contradicts itself/],
  ]
  for (const [anchor, expected] of bad) {
    const finding = validateDocument({ ...MINIMAL, anchors: [anchor] }, 'x.json')
    assert.equal(finding?.ruleId, 'export-invalid', `accepted ${JSON.stringify(anchor)}`)
    assert.match(finding.message, expected)
  }
  assert.equal(
    validateDocument(
      { ...MINIMAL, anchors: [{ from: '/a', to: '/b', context: 'body', hasImage: true, imageAlt: 'Home' }] },
      'x.json',
    ),
    null,
  )
})

test('a context kind outside the declared set is refused', () => {
  const finding = validateDocument({ ...MINIMAL, contexts: [{ id: 'body', kind: 'sidebar' }] }, 'x.json')
  assert.equal(finding?.ruleId, 'export-invalid')
  assert.match(finding.message, /kind" must be one of editorial, navigation/)
  assert.equal(finding.evidence, 'sidebar')
})

test('target aliases must be non-empty strings', () => {
  assert.match(
    validateDocument({ ...MINIMAL, targets: [{ id: '/a', aliases: 'Docs' }] }, 'x.json').message,
    /aliases" must be an array/,
  )
  assert.equal(
    validateDocument({ ...MINIMAL, targets: [{ id: '/a', aliases: ['Docs', ''] }] }, 'x.json').location
      .pointer,
    '/targets/0/aliases/1',
  )
})

test('a second declaration of one context or target id is refused, not silently merged', () => {
  const report = auditExportDocuments({
    documents: [
      { file: 'export.json', data: MINIMAL },
      {
        file: 'shard.json',
        data: {
          schemaVersion: '1',
          contexts: [{ id: 'body', kind: 'navigation' }],
          targets: [{ id: '/docs/', title: 'Something else' }],
        },
      },
    ],
  })

  assert.deepEqual(ruleIds(report).sort(), ['export-invalid', 'export-invalid'])
  // The first declaration is the one that was kept, and the contradiction is
  // reported rather than resolved by accident.
  assert.equal(report.summary.editorialAnchors, 1)
  assert.equal(report.status, 'incomplete')
})

test('two shards disagreeing about defaultLocale is a contradiction, not a merge', () => {
  const report = auditExportDocuments({
    documents: [
      { file: 'export.json', data: MINIMAL },
      { file: 'shard.json', data: { schemaVersion: '1', defaultLocale: 'fr' } },
    ],
  })

  assert.deepEqual(ruleIds(report), ['export-invalid'])
  assert.match(report.findings[0].message, /already declared "en"/)
  assert.equal(report.status, 'incomplete')
})

test('the lexical include gate names every shape it refuses', () => {
  assert.equal(unsafeIncludeReason('anchors/blog.json'), null)
  assert.match(unsafeIncludeReason(''), /non-empty string/)
  assert.match(unsafeIncludeReason(7), /non-empty string/)
  assert.match(unsafeIncludeReason('/etc/passwd'), /relative to the export root/)
  assert.match(unsafeIncludeReason('../outside.json'), /".." segment/)
  assert.match(unsafeIncludeReason('anchors\\blog.json'), /"\/" as its separator/)
  assert.match(unsafeIncludeReason('C:/anchors.json'), /drive-qualified/)
  assert.match(unsafeIncludeReason('anchors//blog.json'), /empty segment/)
  assert.match(unsafeIncludeReason(`anchors/${String.fromCharCode(0)}blog.json`), /NUL/)
})

test('isInside compares real paths and accepts the root itself only as itself', () => {
  assert.equal(isInside('/root', '/root'), true)
  assert.equal(isInside('/root', '/root/a/b.json'), true)
  assert.equal(isInside('/root', '/rooted/a.json'), false)
  assert.equal(isInside('/root', '/other/a.json'), false)
  assert.equal(isInside('/root/a', '/root'), false)
})

test('a symlinked shard that escapes the root is refused and its content never read', async (t) => {
  const directory = await workspace(t)
  const root = join(directory, 'root')
  const outside = join(directory, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(
    join(outside, 'secret.json'),
    JSON.stringify({ schemaVersion: '1', targets: [{ id: '/OUT-OF-ROOT-MARKER' }] }),
  )
  await symlink(join(outside, 'secret.json'), join(root, 'shard.json'))
  await writeFile(join(root, 'export.json'), JSON.stringify({ ...MINIMAL, include: ['shard.json'] }))

  const report = await auditExportFile({ exportFile: join(root, 'export.json'), root })

  assert.deepEqual(ruleIds(report), ['path-escapes-root'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.documents, 1)
  assert.equal(JSON.stringify(report).includes('OUT-OF-ROOT-MARKER'), false)
})

test('a shard genuinely inside a symlinked root is read, not refused', async (t) => {
  const directory = await workspace(t)
  const real = join(directory, 'real-root')
  await mkdir(join(real, 'anchors'), { recursive: true })
  await writeFile(
    join(real, 'anchors', 'blog.json'),
    JSON.stringify({
      schemaVersion: '1',
      anchors: [{ from: '/b', to: '/docs/', context: 'body', text: 'our documentation' }],
    }),
  )
  await writeFile(join(real, 'export.json'), JSON.stringify({ ...MINIMAL, include: ['anchors/blog.json'] }))
  const linked = join(directory, 'linked-root')
  await symlink(real, linked)

  const report = await auditExportFile({ exportFile: join(linked, 'export.json'), root: linked })

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.summary.documents, 2)
  assert.equal(report.summary.checked, 2)
  assert.equal(report.status, 'pass')
  // The shard's own anchor is in the report, so the file really was read.
  assert.deepEqual(
    report.groups.flatMap((group) => group.variants.map((variant) => variant.name)).sort(),
    ['our documentation', 'the documentation'],
  )
})

test('an export file that is itself a symlink out of the root is refused', async (t) => {
  const directory = await workspace(t)
  const root = join(directory, 'root')
  await mkdir(root)
  await writeFile(join(directory, 'elsewhere.json'), JSON.stringify(MINIMAL))
  await symlink(join(directory, 'elsewhere.json'), join(root, 'export.json'))

  const report = await auditExportFile({ exportFile: join(root, 'export.json'), root })

  assert.deepEqual(ruleIds(report), ['path-escapes-root'])
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
})

test('an export path outside the declared root is a configuration error, not a report', async (t) => {
  const directory = await workspace(t)
  const root = join(directory, 'root')
  await mkdir(root)
  await writeFile(join(directory, 'export.json'), JSON.stringify(MINIMAL))

  await assert.rejects(
    () => auditExportFile({ exportFile: join(directory, 'export.json'), root }),
    /outside the export root/,
  )
  await assert.rejects(() => auditExportFile({ exportFile: '' }), /export file path is required/)
  await assert.rejects(
    () => auditExportFile({ exportFile: join(root, 'export.json'), root: join(directory, 'missing') }),
    /root could not be resolved/,
  )
})

test('bytes that are not UTF-8 are a decode failure, never replacement characters', async (t) => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'export.json'), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))

  const report = await auditExportFile({ exportFile: join(directory, 'export.json') })

  assert.deepEqual(ruleIds(report), ['export-undecodable'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
})

test('a valid UTF-8 file holding U+FFFD is still read: validity is never inferred from content', async (t) => {
  const directory = await workspace(t)
  await writeFile(
    join(directory, 'export.json'),
    JSON.stringify({
      ...MINIMAL,
      anchors: [{ from: '/a', to: '/docs/', context: 'body', text: 'documentation \uFFFD' }],
    }),
  )

  const report = await auditExportFile({ exportFile: join(directory, 'export.json') })

  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('malformed JSON and a missing file are both reported, not thrown away', async (t) => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'broken.json'), '{"schemaVersion": "1",')

  const broken = await auditExportFile({ exportFile: join(directory, 'broken.json') })
  assert.deepEqual(ruleIds(broken), ['export-invalid'])
  assert.equal(broken.status, 'incomplete')

  const missing = await auditExportFile({ exportFile: join(directory, 'absent.json') })
  assert.deepEqual(ruleIds(missing), ['export-unreadable'])
  assert.equal(missing.findings[0].location.file, 'absent.json')
  assert.equal(missing.status, 'incomplete')
})

test('a named pipe is refused before it is opened', async (t) => {
  const directory = await workspace(t)
  const pipe = join(directory, 'export.json')
  try {
    execFileSync('mkfifo', [pipe])
  } catch {
    t.skip('mkfifo is unavailable on this host')
    return
  }

  // Without the isFile() guard this read blocks forever: nothing ever writes
  // to the pipe, so the test would hang rather than fail.
  const report = await auditExportFile({ exportFile: pipe })

  assert.deepEqual(ruleIds(report), ['export-unreadable'])
  assert.match(report.findings[0].message, /not a regular file/)
  assert.equal(report.status, 'incomplete')
})

test('a shard included twice is read once and reported once', async (t) => {
  const directory = await workspace(t)
  await writeFile(
    join(directory, 'shard.json'),
    JSON.stringify({
      schemaVersion: '1',
      anchors: [{ from: '/b', to: '/docs/', context: 'body', text: 'our documentation' }],
    }),
  )
  await writeFile(
    join(directory, 'export.json'),
    JSON.stringify({ ...MINIMAL, include: ['shard.json', 'shard.json'] }),
  )

  const report = await auditExportFile({ exportFile: join(directory, 'export.json') })

  assert.deepEqual(ruleIds(report), ['duplicate-include'])
  assert.equal(report.summary.documents, 2)
  assert.equal(report.summary.checked, 2)
  // An info-only finding: a repeated include is noise, not missing evidence.
  assert.equal(report.status, 'pass')
})

test('an include cycle terminates', async (t) => {
  const directory = await workspace(t)
  await writeFile(
    join(directory, 'a.json'),
    JSON.stringify({ ...MINIMAL, include: ['b.json'] }),
  )
  await writeFile(
    join(directory, 'b.json'),
    JSON.stringify({ schemaVersion: '1', include: ['a.json'] }),
  )

  const report = await auditExportFile({ exportFile: join(directory, 'a.json') })

  assert.deepEqual(ruleIds(report), ['duplicate-include'])
  assert.equal(report.summary.documents, 2)
})

test('an unknown limit name and a nonsense limit value are configuration errors', () => {
  assert.throws(
    () => auditExportDocuments({ documents: [], limits: { maxAnchor: 5 } }),
    /Unknown limit "maxAnchor"/,
  )
  assert.throws(() => auditExportDocuments({ documents: [], limits: { maxAnchors: 0 } }), /positive integer/)
  assert.throws(() => auditExportDocuments({ documents: [], limits: { maxAnchors: 1.5 } }), /positive integer/)
  assert.throws(() => auditExportDocuments({ documents: 'x' }), /documents must be an array/)
  assert.throws(() => auditExportDocuments({ documents: [{ data: MINIMAL }] }), /non-empty file name/)
})
