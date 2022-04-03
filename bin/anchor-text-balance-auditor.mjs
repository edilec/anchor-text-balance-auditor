#!/usr/bin/env node

import { auditExportFile, formatReport } from '../src/index.mjs'

const HELP = `anchor-text-balance-auditor

Audit an export of internal anchors: compute each anchor's accessible name,
group the anchor variants by target, context and locale, and report empty,
misleading and over-repeated link text. Nothing is ever fetched.

Usage:
  anchor-text-balance-auditor --export FILE [--root DIR] [--default-locale TAG]
                              [--json] [limits]

Options:
  --export FILE             Anchor export JSON to audit (required)
  --root DIR                Directory that confines the export and every shard
                            it includes (default: the export file's directory)
  --default-locale TAG      Locale for anchors that declare none; replaces the
                            "defaultLocale" declared inside the export
  --json                    Emit the machine-readable report on stdout
  --max-anchors N           Maximum anchors audited (default 50000)
  --max-targets N           Maximum declared targets loaded (default 20000)
  --max-contexts N          Maximum declared contexts loaded (default 512)
  --max-file-bytes N        Maximum bytes per export document (default 8388608)
  --max-include-depth N     Maximum include nesting below the export (default 4)
  --max-include-files N     Maximum included shards (default 64)
  --max-listed N            Maximum ids listed inside one finding (default 10)
  --max-findings N          Maximum findings in a report (default 5000)
  --max-editorial-repeats N Editorial repetitions of one anchor text to one
                            target allowed before it is reported (default 3)
  -h, --help                Show this help

An image-only anchor whose image carries alt text is NOT an empty anchor: its
accessible name is that alt text. Repetition inside a declared navigation
context is expected and is reported as such, never counted against the
editorial repetition budget. "Misleading" means one declared thing only: the
anchor's text is the declared title or alias of a different target than the one
it links to. The tool never judges writing quality.

An anchor whose name comes from aria-labelledby, one in an undeclared context,
one with no locale, or one pointing at an undeclared target is UNKNOWN, not
fine: it makes the report incomplete.

Exit codes:
  0  every audited anchor passed and the evidence was complete
  1  the export failed the audit (empty, unnamed image or misleading anchors)
  2  invalid usage (nothing on stdout), or unreadable/incomplete evidence
     (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-anchors', 'maxAnchors'],
  ['--max-targets', 'maxTargets'],
  ['--max-contexts', 'maxContexts'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-include-depth', 'maxIncludeDepth'],
  ['--max-include-files', 'maxIncludeFiles'],
  ['--max-listed', 'maxListed'],
  ['--max-findings', 'maxFindings'],
  ['--max-editorial-repeats', 'maxEditorialRepeats'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { exportFile: null, root: null, defaultLocale: null, json: false, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--export') options.exportFile = takeValue('--export')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--default-locale') options.defaultLocale = takeValue('--default-locale')
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`${argument} requires a positive integer`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.exportFile === null) throw new Error('--export is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // A configuration error means the run never had a subject: stdout stays
    // empty so a consumer piping JSON never sees a fabricated report.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await auditExportFile({
      exportFile: options.exportFile,
      root: options.root ?? undefined,
      defaultLocale: options.defaultLocale ?? undefined,
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unscoredAnchors} anchor(s) could not be scored and ${report.summary.unresolvedNames} accessible name(s) were unresolved; the evidence does not support a pass.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
