# How the parser reads a Nexis PDF

Everything here describes `src/parser.js`. If you are changing that file, read
this first — most of it is the record of a specific layout quirk that broke a
naive approach.

## The shape of a Nexis export

A Nexis Uni PDF is a cover page followed by articles, each starting on its own
page and ending with a line reading `End of Document`. A typical article's first
page looks like this:

```
Page 1 of 2
Israeli Airstrike on Police Post Leaves Seven Dead   <- running head
Israeli Airstrike on Police Post Leaves Seven Dead   <- title
The New York Times                                   <- publication
July 15, 2026 Wednesday                              <- date
Late Edition - Final                                 <- edition (optional!)
Copyright 2026 The New York Times Company
Section: WORLD
Length: 812 words
Byline: SOMEONE
Body

...article text...

Load-Date: July 16, 2026
End of Document
```

The pipeline is:

1. `src/pdf-text.js` turns each PDF page into text, grouping positioned runs into
   lines by baseline. The app and the test harness both use it, so tests see
   exactly the text the app sees.
2. `parseNexisPdfText` splits pages into articles. A page starts an article if it
   matches `Page 1 of N` **and** carries a document-type marker (`Body` or
   `Reporter`); an article ends at `End of Document`.
3. `parseArticle` detects the document type, then dispatches to
   `parseNewsDocument` or `parseCaseDocument`, which locate anchors in the
   article's lines and slice fields out between them.

## Document types

Nexis exports several kinds of document, and they differ structurally, not just
cosmetically. `detectDocumentType` picks between them:

| Type | Detected by | Notes |
| --- | --- | --- |
| `news` | a standalone `Body` line | Newspapers and wires, plus the *Primary Sources in U.S. Presidential History* collection, which shares the layout with two twists (below) |
| `case` | a standalone `Reporter` line and no `Body` | Court opinions. Structurally alien to news |

**Requiring a `Body` line to recognize an article start once produced zero rows,
silently, for an entire 250-case export.** Detection now accepts either marker,
and `scripts/test-parser.mjs` asserts a non-zero article count per fixture.

### Primary-source documents (no copyright line)

These are public-domain government documents, so Nexis prints **no
`Copyright <year>` line at all** — and the parser used to anchor the whole
masthead on it, blanking `publication` and `publication_date` for all 500
articles in one export. They also print the bibliographic block *below* `Body`
rather than above it:

```
Page 1 of 2
Address Before the Civilian Advisory Board of the Navy…   <- running head
Address Before the Civilian Advisory Board of the Navy…   <- title
Primary Sources in U.S. Presidential History              <- publication
October 7, 1915                                           <- date
Length: 538 words              <- metadata starts here, no Copyright line
Byline: Woodrow Wilson
Body
Document Type: Wilson, Woodrow--Speech [Primary Source]   <- NOT body text
Author: Wilson, Woodrow
Subject Descriptors: National defense; Naval forces; …    <- ends the block
[Page 8076]                                               <- body starts here
```

Two rules follow, both in `parseNewsDocument`:

- `findHeaderEnd` ends the masthead at whichever comes first, the `Copyright`
  line or the first recognized metadata key. Modern news always hits `Copyright`
  first, so this is a no-op there.
- `skipPrimarySourceMetadata` drops the below-`Body` block. It fires only when
  the first body line is `Document Type:` and there is a `Subject Descriptors:`
  line to end on; otherwise it leaves the body alone rather than guess.

The Subject Descriptors list wraps across lines and **breaks mid-phrase**
(`"… Department of"` / `"Interior; Emancipation; …"`), so a trailing separator
does *not* mark a wrap. What distinguishes a wrapped line from the heading that
follows is that wrapped lines still contain a `;`. Do not "fix" this back to a
trailing-separator test — it leaves descriptor text in 40 of 500 bodies.

### Court cases

```
Page 1 of 13
Yick Wo v. Hopkins, 118 U.S. 356          running head
Yick Wo v. Hopkins                        title
Supreme Court of the United States        court    -> publication
Submitted April 14, 1886. ; May 10, …     date(s)  -> publication_date
No Number in Original                     docket
Reporter
118 U.S. 356 *; 6 S. Ct. 1064 **; …       citation
YICK WO v. HOPKINS, SHERIFF.              caption
Prior History: …
Core Terms / Overview / Headnotes / Syllabus / Counsel: / Judges:
Opinion by: / Opinion / Concur by: / Concur / Dissent by: / Dissent
End of Document
```

`parseCaseDocument` walks **up** from `Reporter`: an optional docket line, then
one or more date lines, and the first line above those is the court. Dates wrap
when a case was argued, restored to the docket, and reargued, so they are
consumed greedily — across 250 cases, 6 had multi-line dates.

Case dates do not start with a month (`"Argued December 11, 14, 1885. ; February
1, 1886, Decided"`), so the news `DATE_LINE_RE` matches **none** of them; cases
use their own `CASE_DATE_RE`, which also allows a bare court term with no day
(`"October, 1841, Term"` — *Folsom v. Marsh*).

Sections always appear in one relative order, so each section's text is the span
between its marker and the next marker present. `Opinion` becomes `body`;
`Syllabus`, `Headnotes`, `Counsel`, `Judges`, `Dissent`, `Concur`,
`Prior History`, `Disposition` and the rest get their own columns. A case may
carry several dissents; repeated markers are concatenated, not overwritten.

The `Headnotes` marker appears as both `Headnotes` and `LexisNexis® Headnotes`.

## Running heads

Nexis repeats a running head — the title, or a case name plus citation — under
`Page N of M` at the top of **every continuation page**. Joining pages naively
splices it into the middle of the body once per page break: it accounted for 231
stray title occurrences across 139 NYT articles and 1,823 across 250 cases.
`joinArticlePages` strips it, but only on an exact match against the running head
taken from page 1, so an unrecognized layout keeps its text rather than losing a
real line. `raw_text` is built from the unmodified pages and still contains it.

## Anchors

Rather than counting lines from the top, the parser finds landmark lines and
works relative to them. The important ones:

| Anchor | Pattern |
| --- | --- |
| `bodyIndex` | first line exactly equal to `Body` |
| `loadDateIndex` | **last** line matching `^Load-Date:` |
| `endOfDocumentIndex` | **last** line equal to `End of Document` |
| `copyrightIndex` | first line matching `^Copyright\s*(©\s*)?\d{4}` |
| `headerEndIndex` | the earlier of `copyrightIndex` and the first metadata key |
| `reporterIndex` | (cases) first line equal to `Reporter` |

Both Load-Date and End-of-Document use *last*, not first, so a stray occurrence
earlier in prose can only extend the body, never truncate it early.

## publication and publication_date

This is the fiddliest part, and the source of the worst bug this parser has had.

The block above `Copyright <year>` is: **publication name, date, then zero or
more edition lines.** The edition line is optional, and the original parser
assumed it was never there — it took `copyrightIndex - 2` and `copyrightIndex - 1`
as publication and date. For the 157 of 500 articles in one export that *did*
carry an edition line, everything shifted by one: `publication` received the
date, `publication_date` received `Late Edition - Final`, and the actual
publication name was silently dropped.

The fix anchors on the date instead. Searching up from `Copyright`, the first
line matching `DATE_LINE_RE` is the date, and the line directly above it is the
publication — regardless of how many edition lines sit in between.

`DATE_LINE_RE` matches four real formats:

| Format | Example |
| --- | --- |
| Month D, YYYY | `July 19, 2026` |
| D Month YYYY | `19 July 2026` |
| Month YYYY | `July 2026` (ABC Regional News does this) |
| ISO | `2026-07-19` |

**It is anchored on real month names on purpose.** An earlier version used
`^[A-Z][a-z]+ ...\d{4}`, i.e. any capitalized word followed by a year. That
matched *headlines* — `Hamas 2026 Offensive Explained` — so when an article's
real date was in an unrecognized format, the search walked up past it and
returned the headline as the date, with no warning. Widening this regex again is
fine; widening it to "any word" is not.

The search window is `MAX_EDITION_LINES + 1` lines. Observed maximum in real
exports is 2; the cap keeps the search from ever reaching the headline.

Real lines seen in the edition slot, which is *not* always an edition:

```
Edition 1, National Edition      Delivered by Newstex LLC. All Rights Reserved
Final Edition                    University Wire
Late Edition - Final             Delhi Edition / Mumbai Edition / ...
Digital Edition                  FM 16/07/2026 01FM1607MainBody 36 Money AL FM_Mainbody Edition
```

### The © in the copyright line

`copyrightIndex` allows an optional `©` (`Copyright © 2026 Tortoise Media`).
Without it the anchor is not found at all, and both fields come out blank. Two of
750 copyright lines in one export used that form.

Note also that ~half of articles in a mixed export contain **more than one**
`Copyright <year>` line — a distributor line followed by a publisher line, e.g.
`Copyright 2026 Content Engine, LLC.` above `Copyright 2026 Adam Smith, Great
Britain`. Taking the first is correct, because the header block always precedes
any copyright text inside the body.

## body

The body runs from the `Body` marker to the Load-Date line, or to
`End of Document` when the article has no Load-Date:

```js
const bodyEndIndex = loadDateIndex >= 0 ? loadDateIndex : endOfDocumentIndex >= 0 ? endOfDocumentIndex : lines.length;
```

The second branch matters: without it, articles with no Load-Date ended at
`lines.length` and carried the literal text `End of Document` into the body.

`cleanBody` drops page headers (`Page 3 of 7`) and the LexisNexis footer, then
joins paragraphs with blank lines.

## title

Titles come from the PDF's **link annotations**, not the text, because Nexis
prints the headline twice — once as a running head, often truncated with an
ellipsis (`...the Appoin....`) — and wraps it across lines differently in each
place. The annotation covering the title band gives the untruncated headline.
`extractTitle` falls back to the first line if no annotation is present.

`extractNexisLink` uses the same annotations to recover the article's canonical
`advance.lexis.com` permalink.

## Warnings

The parser writes to `console.warn` rather than failing. Seeing these in the
browser console means a document did not match the expected layout:

| Warning | Meaning |
| --- | --- |
| `no "Copyright <year>" line found` | Anchor missing; `publication` and `publication_date` are blank |
| `no recognizable date line above "Copyright"` | Date format not in `DATE_LINE_RE`; fell back to fixed offsets |
| `publication looks like a date` | The off-by-one failure described above has recurred |
| `publication came out blank` | Layout matched but the line above the date was empty |

The last two are invariants checked *after* the fact — they exist because the
original bug was invisible in the output until a human read the rows.

## Source quirks that are not bugs

Things that look wrong in the output but faithfully reflect what Nexis printed.
Worth knowing before you aggregate this data.

- **Broadcast transcripts** put the programme and airtime in the publication
  slot: `Fox News LIFE, LIBERTY, LEVIN 8:00 PM EST`, `The Dose 9:00 PM EST
  CBC-NN`. Grouping by publication will scatter one network across many values.
  These articles also use `Anchors:` / `Guests:` instead of `Byline:`, which the
  parser does not currently capture.
- **Aggregator wrapper lines.** Newstex-delivered blogs print `Newstex Blogs`
  above the real source. The parser returns the specific blog
  (`Adam Smith Institute Blog`) and discards the aggregator.
- **The same article delivered twice** through different distributors, with
  different publication names and word counts. One 500-article export had 37
  duplicate-title groups. Deduplicate on `nexis_link` or `body_sha256`, not
  `title`.
- **Contributor strings in the publication slot**, e.g. `ARRN Contributors`,
  where the actual masthead appears only in the copyright line.
- **Blank `section` / `byline` / `dateline`** — usually genuinely absent. Check
  `raw_text` before assuming a parse failure.

## Adding a regression test

`scripts/test-parser.mjs` holds a `FIXTURES` list. Add your PDF to `tests/`
(gitignored — never commit Nexis content) and an entry naming the file plus a
`check(articles)` function. Assert counts and a few specific rows; the existing
entries assert the © case and the month-only date case by looking up articles by
publication name rather than by index, so they survive re-exports.
