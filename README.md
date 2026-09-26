# anchor-text-balance-auditor

Audit an export of internal anchors: compute each anchor's accessible name, group the anchor
variants by target, context and locale, and report empty, misleading and over-repeated link text.

Two distinctions carry the whole tool:

- **An image-only anchor is not an empty anchor.** `<a href="/"><img alt="Home"></a>` has the
  accessible name `Home`. Reporting it as empty is a false positive, and a false refusal is a bug
  exactly as real as a missed defect. A truly empty anchor has no aria-label, no text, no image alt
  and no title.
- **Navigation anchors repeat by design.** A "Documentation" link in every header is the site
  working as intended, so repetition inside a declared navigation context is reported as expected
  and never counted against the editorial budget. The same repetition among in-body editorial
  anchors is what an editor wants to see.

Zero dependencies, Node built-ins only, Node >= 22.

- **Repository:** [edilec/anchor-text-balance-auditor](https://github.com/edilec/anchor-text-balance-auditor)
- **Rules, format and limits:** [docs/anchor-rules.md](./docs/anchor-rules.md)
- **License:** MIT

## Usage

```sh
node bin/anchor-text-balance-auditor.mjs --export examples/site-clean.json
node bin/anchor-text-balance-auditor.mjs --export examples/site-broken.json --json
```
anchor-text-balance-auditor: status pass
21 anchor(s) from 2 export document(s); 21 named, 0 unnamed, 0 unresolved, 5 image-only but named.
7 editorial and 14 navigation anchor(s) over 3 declared context(s); 0 not scored.
11 anchor variant(s) in 9 target/context/locale group(s): 0 over-repeated, 2 expected navigation repeat(s), 0 ambiguous, 0 misleading.
0 error, 0 warning, 2 info.
INFO    site-clean.json /anchors/0 navigation-repetition-expected Navigation anchor text "example handbook home" points at "/" 5 time(s) in locale "en"; repetition in a navigation context is expected and was not counted against the editorial budget.
INFO    site-clean.json /anchors/5 navigation-repetition-expected Navigation anchor text "docs" points at "/docs/" 5 time(s) in locale "en"; repetition in a navigation context is expected and was not counted against the editorial budget.
```

`--json` writes the machine-readable report; stdout carries that and nothing else, and stderr
carries diagnostics.

## The input

The tool reads an **export** a crawler or build step produced. It never fetches anything.

```json
{
  "schemaVersion": "1",
  "defaultLocale": "en",
  "contexts": [
    { "id": "header-nav", "kind": "navigation" },
    { "id": "article-body", "kind": "editorial" }
  ],
  "targets": [{ "id": "/docs/", "title": "Documentation", "aliases": ["Docs"] }],
  "anchors": [
    { "from": "/", "to": "/docs/", "context": "header-nav", "text": "Docs" },
    { "from": "/", "to": "/", "context": "header-nav", "hasImage": true, "imageAlt": "Home" },
    { "from": "/blog/a", "to": "/docs/", "context": "article-body", "text": "the reference" }
  ]
}
```

`include` shards the export across several files, confined to an export root by real path after
symlink resolution. Unknown keys are refused: a one-character typo must not silently disable a
field and turn a real failure green. The full format is in
[docs/anchor-rules.md](./docs/anchor-rules.md).

## What it reports

| Rule | Severity | Meaning |
| --- | --- | --- |
| `empty-anchor-text` | error | The anchor has no accessible name at all. |
| `image-anchor-unnamed` | error | An anchor containing an image has no text and no usable alt. |
| `misleading-anchor-text` | error | The text is the declared title or alias of a **different** target. |
| `over-repeated-anchor-text` | warning | One editorial anchor text points at one target too often. |
| `ambiguous-anchor-text` | warning | One anchor text points at several targets in one context and locale. |
| `navigation-repetition-expected` | info | Repetition in a navigation context. Expected, and stated so. |

Twenty-four rules in total, including the ones that refuse an input rather than judge it. Severity
comes from a single frozen `ruleId -> severity` table; an unknown rule id throws, and the test suite
asserts the table against the documented catalog in both directions. It also runs every one of the
twenty-four rules through the CLI and asserts the `status` and exit code that come back, because
declarations agreeing with each other can be flipped together and an exit code cannot.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every audited anchor passed and the evidence was complete. | report |
| 1 | The audit failed: an error-severity finding, and no evidence missing. | report |
| 2 | Invalid usage. | **empty** |
| 2 | Input that could not be read or decoded, or evidence that was missing. | `status: "incomplete"` report |

A usage error means the run never had a subject, so there is nothing to report about. An unreadable
input means the run had a subject and failed to obtain evidence about it — a consumer piping stdout
must handle both. `incomplete` outranks `fail`, so a rule that is error-severity **and** missing
evidence — `export-invalid`, `file-too-large`, any `too-many-*` — exits 2, never 1.

## Limits and non-goals

**Unknown evidence is never a pass.** Four things make a run `incomplete` even though nothing
failed: an anchor named through `aria-labelledby` (an export cannot resolve it), an anchor in an
undeclared context (its kind is unknown, so repetition cannot be scored), an anchor with no locale
and no `defaultLocale`, and an anchor pointing at an undeclared target. Each is reported as a
warning, and the report is still not a pass.

This tool **cannot** tell you:

- **Whether the writing is good.** There is no list of weak phrases, no readability score and no
  opinion about wording. "Misleading" means one declared, evidence-backed thing: the text is the
  declared name of a different target. A target with no declared `title` or `aliases` has no name to
  compare against, and silence there is absence of evidence, not proof.
- **Whether a link works, or a target exists.** Nothing is ever fetched. Every claim is about the
  export in front of it, which may be stale, partial or wrong.
- **What the HTML actually said.** It audits what the exporter recorded. An exporter that drops an
  image's alt, joins text nodes wrongly or misses an anchor produces an audit of that mistake.
- **The DOM order inside an anchor.** `text` and `imageAlt` are joined text-then-alt, so an anchor
  whose image precedes its text groups under a name in the other order.
- **Whether a name is perceivable.** Whitespace is trimmed, but a name made of invisible
  non-whitespace characters counts as a name.
- **Anything across locales.** Two locales are two scoring universes; it will not tell you that a
  translation is missing or wrong.
- **That a repetition is wrong.** `maxEditorialRepeats` is a policy number somebody chose, which is
  why over-repetition and ambiguity are warnings while the structurally verifiable defects are
  errors.

Every limit — anchors, targets, contexts, bytes per file, include depth, include files, listed ids,
findings, editorial repeats — is enforced, reported when it is hit, and covered by a test. Dropped
evidence is never silent: each of those limits raises the finding named in the catalog, and a
bounded list inside a finding ends in `(+N more)` rather than trailing off. The one bounded list
that is not itself a finding — a variant's `sources` — stands beside the exact `count` and `pages`
it samples, so what it omits stays readable from the report.

## Verify

```sh
npm run check
```

Runs `lint` (`node --check` per file), `test` (`node --test`), `example`, and `pack:check`.

## License

MIT. See [LICENSE](./LICENSE).
