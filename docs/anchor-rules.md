# Anchor rules, export format, limits and determinism

This document is the reference for what `anchor-text-balance-auditor` computes, what each rule
means, and what the tool refuses to claim. Rule ids are stable: renaming one is a breaking change
and is recorded in the changelog.

## The export format

The tool reads an **export**: a JSON document holding the internal anchors a crawler or a build
step found, the targets those anchors may point at, and the contexts the anchors were found in. It
never fetches anything, so the export is the whole of its evidence.

```json
{
  "schemaVersion": "1",
  "site": "optional label",
  "defaultLocale": "en",
  "include": ["anchors/blog.json"],
  "contexts": [
    { "id": "header-nav", "kind": "navigation", "label": "Site header" },
    { "id": "article-body", "kind": "editorial" }
  ],
  "targets": [
    { "id": "/docs/", "title": "Documentation", "aliases": ["Docs"] }
  ],
  "anchors": [
    { "from": "/", "to": "/docs/", "context": "header-nav", "text": "Docs" },
    { "from": "/", "to": "/", "context": "header-nav", "hasImage": true, "imageAlt": "Home" }
  ]
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | Must be `"1"`. |
| `site` | string, optional | A label. Never interpreted. |
| `defaultLocale` | string, optional | Locale for anchors that declare none. `--default-locale` replaces it. |
| `include` | string array, optional | Relative POSIX paths to further export documents, merged into this one. |
| `contexts` | array, optional | Where anchors were found. Each entry is `{ id, kind, label? }`. |
| `targets` | array, optional | The pages anchors may point at. Each entry is `{ id, title?, aliases? }`. |
| `anchors` | array, optional | The anchors themselves. |

### Context entries

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | The id anchors refer to. Declared exactly once across the whole export. |
| `kind` | string | `navigation` or `editorial`. Nothing else is accepted. |
| `label` | string, optional | Human label. Never interpreted. |

### Target entries

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | The id anchors point at, compared exactly. Declared exactly once. |
| `title` | string, optional | The page's declared name, used by `misleading-anchor-text`. |
| `aliases` | string array, optional | Other declared names for the same page. |

### Anchor entries

| Key | Type | Meaning |
| --- | --- | --- |
| `from` | string | Page the anchor is on. |
| `to` | string | Target id the anchor points at. |
| `context` | string | Context id the anchor was found in. Required: repetition means nothing without it. |
| `locale` | string, optional | Falls back to `defaultLocale`. |
| `text` | string, optional | The anchor's text nodes, already concatenated by the exporter. |
| `hasImage` | boolean, optional | True when the anchor contains an image element. |
| `imageAlt` | string, optional | The image's alt text. Requires `hasImage: true`. |
| `ariaLabel` | string, optional | The anchor's `aria-label`. |
| `labelledBy` | string, optional | The anchor's `aria-labelledby` value, unresolved. |
| `title` | string, optional | The anchor's `title` attribute. |

A page id, target id, context id and locale tag are **opaque strings** compared exactly. The tool
does not normalise URLs, resolve relative references, strip query strings, collapse trailing
slashes or fold case in ids; `/a` and `/a/` are two different targets. Whatever normalisation your
exporter applies is the normalisation that holds.

**Unknown keys are rejected.** A document, context, target or anchor entry carrying a key that is
not in the tables above produces `export-invalid` and the document is not merged. A one-character
typo that silently disabled a field would turn a real failure into a green run, so it is refused
instead.

**The first violation stops that document.** An export is machine-produced: a partially understood
one is evidence the tool does not have, so it is refused rather than half-used.

**An `imageAlt` without `hasImage: true` is refused.** The record contradicts itself, and accepting
it would let an exporter bug hide an unnamed image anchor behind alt text no image carries.

### Sharded exports

`include` lets an exporter write its anchors in several files. Each entry is resolved against the
**export root** — the directory given by `--root`, defaulting to the directory holding the export
file. Resolution is confined twice:

1. lexically, before anything is touched: no absolute path, no `..` segment, no empty segment, no
   backslash separator, no drive prefix, no NUL;
2. by **real path**: the candidate is resolved through every symlink with `realpath`, and the
   result must still be inside the real root — which is itself resolved with `realpath`.

Both sides are real paths. Comparing a resolved root against an unresolved candidate refuses files
that are genuinely inside the root, and a false refusal is a bug exactly as real as a false
acceptance. A file reached through a symlinked root is read; a symlink inside the root that points
out of it is refused with `path-escapes-root` and its bytes are never read.

Every document is decoded with `TextDecoder('utf-8', { fatal: true })`. Encoding validity is never
inferred from decoded content: a file holding a literal U+FFFD is valid UTF-8 and is read, while
bytes that are not UTF-8 produce `export-undecodable` and are not audited.

## The accessible name

The audit is about the name a user actually perceives, computed in the order a browser computes it
from the parts an export can carry:

1. `labelledBy` — if present and not blank, the name is **unresolved**. The elements it points at
   are not in the export, so the name is unknown: neither named nor empty, and never a pass.
2. `ariaLabel`, when it is not blank. An empty or whitespace `aria-label` is ignored and the
   content is used instead, exactly as the accessible name computation ignores it.
3. The content: `text` and `imageAlt`, joined with a space when both are present.
4. `title`, as a last resort.
5. Otherwise the anchor has **no accessible name**.

**An image-only anchor is not an empty anchor.** `<a href="/"><img alt="Home"></a>` has the
accessible name `Home`. Reporting it as empty is a false positive; the tool counts it in
`summary.imageOnlyNamed` instead. A truly empty anchor — no aria-label, no text, no image alt, no
title — is reported as `empty-anchor-text`, or as `image-anchor-unnamed` when an image is present
and the alt is missing or empty, because there the fix is the alt attribute.

Names are folded for grouping by collapsing whitespace and lowercasing with
`String.prototype.toLowerCase`, which is locale-independent. `toLocaleLowerCase` would make two
hosts group the same export differently.

## Navigation versus editorial

Navigation anchors repeat by design. A "Documentation" link in every header is the site working as
intended, so repetition inside a context declared `navigation` is reported as
`navigation-repetition-expected` — an `info` finding that names the repetition and states that it
was not counted against the editorial budget. The identical pattern inside a context declared
`editorial` is reported as `over-repeated-anchor-text`.

This is why `context` is required on every anchor and why an undeclared context is
`context-undeclared`, not a guess. Scoring an anchor whose context kind is unknown would be exactly
the "unknown reported as known" defect.

## Grouping

Anchor variants are grouped by **target, context kind and locale**. Each group in the report is:

```json
{
  "locale": "en",
  "context": "editorial",
  "target": "/docs/",
  "variants": [
    {
      "name": "read the guide",
      "example": "Read the guide",
      "nameSource": "text",
      "count": 4,
      "pages": 4,
      "sources": ["/blog/a", "/blog/b"]
    }
  ]
}
```

`name` is the folded grouping key, `example` the first name seen for it, `count` the exact
number of anchors, `pages` the number of distinct `from` pages, and `sources` a list of `from`
pages bounded by `maxListed` — `count` is exact even when `sources` is truncated.

An anchor is scored only when its name, its context kind and its locale are all known. Anything
else is counted in `summary.unscoredAnchors` and has already produced a finding that forces an
incomplete report.

## Rule catalog

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `ambiguous-anchor-text` | warning | no | One anchor text points at two or more targets inside one locale and context kind. |
| `anchor-name-unresolved` | warning | yes | The name comes from `aria-labelledby`, which an export cannot resolve. Unknown, not fine. |
| `context-undeclared` | warning | yes | An anchor names a context that was never declared, so it could not be scored. |
| `duplicate-include` | info | no | A shard is included more than once; it was read the first time only. |
| `empty-anchor-text` | error | no | The anchor has no accessible name at all and no image to explain it. |
| `empty-export` | error | yes | No anchor was audited, so there is no evidence to pass on. |
| `export-invalid` | error | yes | A document is not valid JSON, not the declared schema, carries an unknown key, or contradicts another document. |
| `export-undecodable` | error | yes | A document is not valid UTF-8; it was not audited. |
| `export-unreadable` | error | yes | A document could not be examined or read, or is not a regular file. |
| `file-too-large` | error | yes | A document is above `maxFileBytes`; it was not read. |
| `image-anchor-unnamed` | error | no | An anchor containing an image has no text and no usable alt, so it has no accessible name. |
| `include-depth-exceeded` | error | yes | Include nesting is above `maxIncludeDepth`; that shard was not read. |
| `locale-undeclared` | warning | yes | An anchor has no locale and no `defaultLocale` was declared, so its variants could not be grouped. |
| `misleading-anchor-text` | error | no | The anchor text is the declared title or alias of a different target than the one it links to. |
| `navigation-repetition-expected` | info | no | Repeated anchor text in a navigation context. Expected, and not counted against the editorial budget. |
| `over-repeated-anchor-text` | warning | no | One editorial anchor text points at one target more than `maxEditorialRepeats` times. |
| `path-escapes-root` | error | yes | A real path resolved outside the real export root; it was refused and not read. |
| `target-undeclared` | warning | yes | An anchor points at a target the export does not describe, so its text could not be compared against a name. |
| `too-many-anchors` | error | yes | The export is above `maxAnchors`; the remaining anchors were not audited. |
| `too-many-contexts` | error | yes | The export is above `maxContexts`; the remaining contexts were not loaded. |
| `too-many-findings` | error | yes | The report is above `maxFindings`; the remaining findings were not reported. |
| `too-many-include-files` | error | yes | The export is above `maxIncludeFiles`; the remaining shards were not read. |
| `too-many-targets` | error | yes | The export is above `maxTargets`; the remaining targets were not loaded. |
| `unsafe-include-path` | error | yes | An include path failed the lexical gate; it was refused and not read. |

Severity comes from one frozen `ruleId -> severity` table in `src/rules.mjs`. An unknown rule id
throws rather than defaulting to something harmless, and the test suite asserts this catalog and
that table against each other in both directions, including the incomplete column.

**Why `over-repeated-anchor-text` and `ambiguous-anchor-text` are warnings.** Both are policy
signals: the repetition threshold is a number somebody chose, and two links sharing wording may be
deliberate. `empty-anchor-text`, `image-anchor-unnamed` and `misleading-anchor-text` are errors
because each is structurally verifiable from the export alone.

## Limits

| Limit | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `maxAnchors` | `--max-anchors` | 50000 | Anchors audited across all documents. |
| `maxTargets` | `--max-targets` | 20000 | Declared targets loaded. |
| `maxContexts` | `--max-contexts` | 512 | Declared contexts loaded. |
| `maxFileBytes` | `--max-file-bytes` | 8388608 | Bytes per export document, checked before it is read. |
| `maxIncludeDepth` | `--max-include-depth` | 4 | Include nesting below the root export. |
| `maxIncludeFiles` | `--max-include-files` | 64 | Included shards. |
| `maxListed` | `--max-listed` | 10 | Ids listed inside one finding or one variant's `sources`. |
| `maxFindings` | `--max-findings` | 5000 | Findings in one report. |
| `maxEditorialRepeats` | `--max-editorial-repeats` | 3 | Editorial repetitions of one anchor text to one target before it is reported. |

Every limit is enforced, reported when it is hit, and covered by a test. Exceeding one is never a
silent truncation: it produces the finding named above, and every limit except `maxListed`,
`maxFindings` and `maxEditorialRepeats` makes the report incomplete because evidence was dropped.
`maxFindings` and `maxEditorialRepeats` are policy knobs, and `maxListed` bounds evidence strings
while exact counts stay in the message and the summary. An unknown limit name, or a value that is
not a positive integer, is a configuration error.

## Determinism

- Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then `message`.
- Groups sort by `locale`, then context kind, then `target`; variants sort by folded name; the
  `sources` list sorts by page id.
- Every comparison is by UTF-16 code unit. `localeCompare` depends on ICU data that varies between
  Node builds and has already produced a real ordering difference in this catalog.
- No wall-clock time, locale, hash-map iteration order or filesystem enumeration order affects
  output. Running the tool twice over identical inputs produces byte-identical stdout.

## Text that reaches the report

A page id, a target id, a context id, a locale tag and an anchor's text are export content: data,
never an instruction, and never a report line of their own. Before any of them reaches a message, a
suggestion, an evidence list, a `location.file` or a `groups` entry, these characters are replaced
with a space:

| Class | Code points | Why |
| --- | --- | --- |
| C0 | U+0000-U+001F | A newline forges a finding line; ESC starts a terminal sequence. |
| DEL | U+007F | |
| C1 | U+0080-U+009F | U+0085 NEL ends a line for Python's `splitlines`; U+009B is the 8-bit CSI. |
| Separators | U+2028, U+2029 | A line break to several JSON and JavaScript consumers. |
| Bidi | U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 | U+202E reverses everything displayed after it, so one id can read as another. |

**Both reports are flattened, not just the human one.** `JSON.stringify` escapes none of U+2028,
U+2029 and U+0085, so a raw byte left in a message would hand a line-oriented consumer of the JSON
report the line the human report refused. Flattening happens where findings and groups are built,
so there is one place to remove it from rather than one per printing site.

Characters that are merely invisible — a zero-width space, a soft hyphen — are left exactly as they
arrived: they cannot forge a line or reverse one, and a name made of them still counts as a name.
Nothing is deleted, so text around a flattened character stays readable, and lengths are bounded
separately by `maxListed` and the 160-character evidence excerpt.

## Streams and exit codes

stdout carries the JSON report and nothing else, so it can be piped straight into a parser. stderr
carries diagnostics.

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every audited anchor passed and the evidence was complete. | report |
| 1 | The export failed the audit: at least one error-severity finding. | report |
| 2 | Invalid usage. | **empty** |
| 2 | Input that could not be read, decoded or parsed, or evidence that was missing. | a report with `status: "incomplete"` |

A usage error means the run never had a subject, so there is nothing to report about. An unreadable
input means the run had a subject and failed to obtain evidence about it, which is exactly what
`incomplete` exists to say — and a consumer needs that report to know which input was not read.

## What this tool cannot conclude

- **It does not judge writing.** There is no list of weak phrases, no readability score and no
  opinion about wording. "Misleading" means one declared thing: the text is the declared name of a
  different target.
- **It never fetches anything.** It cannot tell you that a target exists, that a page still links
  the way the export says, or that the export is current.
- **It does not parse HTML.** It audits what the exporter recorded. An exporter that drops an
  image's alt, joins text nodes wrongly, or misses an anchor produces an audit of that mistake.
- **It cannot resolve `aria-labelledby`.** Those anchors are reported unresolved, not guessed at.
- **It does not know DOM order.** `text` and `imageAlt` are joined text-then-alt, so an anchor
  whose image precedes its text groups under a name in the other order.
- **It does not judge whether a name is perceivable.** Whitespace is trimmed, but a name made of
  invisible non-whitespace characters — a zero-width space, for instance — counts as a name.
- **It does not compare across locales.** Two locales are two scoring universes, and it will not
  tell you that a translation is missing or wrong.
- **A target with no declared `title` or `aliases` has no name to compare against**, so
  `misleading-anchor-text` stays silent for it. Silence there is absence of evidence, not proof.
