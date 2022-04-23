# Changelog

All notable changes to this project are recorded here. Rule ids are part of the public contract:
renaming one is a breaking change and is recorded as such.

## Unreleased

### Added

- Accessible name computation over an exported anchor: `aria-labelledby` first (unresolvable, so
  reported unknown), then a non-blank `aria-label`, then the content — text nodes joined with image
  alt — then `title`. An image-only anchor whose image carries alt text is named, not empty; an
  anchor with none of these is `empty-anchor-text`, or `image-anchor-unnamed` when an image is
  present and the fix is its alt attribute.
- Anchor variants grouped by target, context kind and locale, each with the folded name, an example
  of the raw text, the exact anchor count, the number of distinct source pages, and a bounded list
  of those pages.
- Separate scoring for navigation and editorial contexts: repetition in a declared navigation
  context is reported as `navigation-repetition-expected` and never counted against the editorial
  budget, while `over-repeated-anchor-text` raises the same pattern among editorial anchors.
- `misleading-anchor-text`: an anchor whose accessible name is the declared title or alias of a
  different target than the one it links to. Declared, evidence-backed, and never a judgement of
  writing quality.
- `ambiguous-anchor-text`: one anchor text pointing at several targets inside one locale and
  context kind.
- `anchor-name-unresolved`, `context-undeclared`, `locale-undeclared` and `target-undeclared`:
  evidence the export does not carry is reported unknown and forces an `incomplete` report.
- Sharded exports through `include`, confined to an export root by real path after symlink
  resolution on both sides, with a lexical pre-check, a cycle-safe visited set and bounded nesting.
- Strict UTF-8 decoding of every document; a decode failure is the finding, and encoding validity is
  never inferred from decoded text.
- CLI with `--help`, `--json`, `--export`, `--root`, `--default-locale` and a flag for each of the
  nine documented limits.
- `docs/anchor-rules.md`: export format, rule catalog with severity and incomplete columns, limits,
  determinism, exit codes and what the tool cannot conclude.
- Examples for each outcome: `site-clean.json` (pass, including expected navigation repetition and
  five named image-only anchors), `site-broken.json` (fail), `site-unknown.json` (incomplete).

### Fixed

- A finding that samples anchors — `context-undeclared`, `target-undeclared` — stopped collecting at
  `maxListed`, so the evidence list printed no "+N more" and read as if those were all of them. The
  list now carries the real total, and the limit test asserts the hidden count.

### Notes

- Severity comes from one frozen `ruleId -> severity` table; an unknown rule id throws.
- The rules that force `status: "incomplete"` are declared as data, and every one of them has a
  scenario asserting the report status, so deleting an entry fails a test. Four of those rules are
  warnings, where that list is the only thing standing between missing evidence and exit 0.
- `status: "pass"` with `checked: 0` is impossible: the one place that decides status emits
  `empty-export` instead.
- Ordering is pinned by tests whose fixtures make code-unit order and ICU collation genuinely
  disagree, declared in the opposite order, so `localeCompare` cannot be substituted unnoticed.
- The human report prints exactly one line per finding: ids, paths and messages are flattened, so an
  anchor id holding a newline or U+2028 cannot forge a line no finding stands behind. The JSON
  report is flattened identically -- `JSON.stringify` escapes neither U+2028, U+2029 nor U+0085 --
  and so are the bidi controls that reverse or hide displayed text.
- The guard that refuses a non-regular export file is defended by a named pipe, which blocks forever
  without it; a directory cannot stand in, because reading one fails anyway.

No release has been published.
