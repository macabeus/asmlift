// The command files under `.claude/commands/` are a SPECIFICATION agents follow literally, and
// nothing mechanical has ever looked at them. Defects this suite makes impossible, each with an
// incident behind it:
//
//   1. DUPLICATED INSTRUCTIONS. The two files carried the same 81 lines verbatim — the whole cost
//      section plus the `pr-wait.sh` bullet — and the repo's own rule is that a shared instruction
//      is corrected in the doc it links, never in two prompts. The last time a repro rule lived in
//      only one of the two, a round published a score against a baseline measured with different
//      flags (#76, diagnosed in #79).
//   2. AN UNDATED COST. Every figure in `docs/bench-cost.md` is a measurement of a moving thing:
//      the real tier went 434 s -> 1,880 s in 17 days on an unchanged 252 rows. A figure without
//      the date it was taken reads as current forever, and the table it lived in was four months
//      stale when this suite was written.
//   3. A STALE COST. A date alone is not freshness: the first version of this suite passed a row
//      re-dated `(2019-03-04)`, and passed the OLD wrong figure carrying an OLD date. So §1's rows
//      are also checked against the artifact's own `meta.generatedAt` — a clock that advances only
//      when somebody actually paid for the run this table prices, which is exactly who can cheaply
//      re-date it, and which never reddens a PR that ran no bench.
//   4. A RETYPED COST. `~34 min` for a full bench was retyped into three places under `.claude/`
//      the moment the doc was written. When it becomes 45, two of the three drift. A figure §1
//      states is therefore illegal inside a prompt — ANY of them, dated or not, because the first
//      remediation of the round that wrote this rule immediately put five freshly-dated figures
//      back into the two prompts. Link the table; do not copy a cell out. The banned set is read
//      out of §1 itself, so there is no second list to drift.
//   5. A LINK THAT DOES NOT RESOLVE. The prompts delegate half their content to `docs/`; a link
//      that 404s sends the agent back to inference.
//   6. A GHOST SUBCOMMAND. #192 changed four `pnpm bench` commands and no prompt was updated; the
//      dispatch in `apps/benchmark/src/cli.ts` is the authority on which ones exist.
//   7. A PATH INTO THE USER'S FROZEN CHECKOUT. The workflow brief generator handed its agents
//      `${REPO}/.claude/...`; 16 of 21 spec reads across rounds #183-#188 landed on text tens of
//      commits stale. A ref (`git show origin/main:<path>`) cannot go stale; a path there always can.
//   8. A COUNT OF A LIST THE SPEC LINKS. A round widened `pr-wait.sh`'s exit-code table from four
//      rows to six and, in the SAME commit, wrote "its four exit codes" into a prompt — the defect
//      it had just diagnosed, now with the doc's authority behind it. A count is the smallest
//      possible copy of a list. (This is the structural cost of defect 1's gate: its only
//      enforceable remedy for shared text is "make the two files differ", and it cannot tell
//      move-to-doc from reword. The rewording is where the divergence entered.)
//   9. A DERIVABLE FIGURE LEFT AS PROSE. `docs/bench-cost.md` §3 states five fields of
//      `results/results.json` in prose, and `CountCollectedGems`'s fan is hand-typed in several
//      files while being one integer in that same committed JSON. §3 is checked against the
//      artifact rather than read; nothing before checked it at all.
//  10. A VERDICT THAT CLOSES A ROW, WITH NO EVIDENCE BEHIND IT. A precedent that asks for MORE work
//      is self-correcting — the round measures, and a wrong precedent costs time. One that tells the
//      agent to STOP is not: acting on it means not measuring, so the claim is never re-tested and
//      its reason is never checked. The unmatchable-quirk bullet named a row and linked nothing;
//      the round sent to re-test it found the classification right and the stated reason too weak
//      to decide the case, and re-derived the verdict from the compiler. A `docs/` link is the
//      weakest thing that closes it, and the two checks around it do the rest: `citations.test.ts`
//      holds the linked page's rows to still existing, the link check below refuses a 404.
//      The FIRST version of this gate examined 0 of 175 blocks, because it keyed on a word its own
//      branch had deleted two commits earlier — green with the evidence link removed. The SECOND
//      examined 2, and one of them was `## Hard rules` — an 18-line block holding the word
//      `unmatchable` and an unrelated `docs/` link — so the `examined > 0` tripwire added for the
//      first defeat was held up by a decoy and the gate was green with its subject deleted again.
//      Hence the pinned inhabitant SET below rather than a count: this gate has twice been a
//      comment with a test runner attached, and nothing else in this file would have said so.
//
// WHAT IT STILL CANNOT DECIDE, so that nobody reads more into a green run than is there:
//   - It cannot check that an instruction is TRUE. Only a command run can.
//   - The recency gate tests "a date near the row is within N days of `meta.generatedAt`", which
//     cannot tell a RE-MEASURED row from a RE-STAMPED one: `sed -i 's/<old date>/<today>/'` passes
//     it. What it buys is that somebody must look at every row on every published run. For the
//     five §3 figures the artifact check above closes it properly; for §1's three tier wall clocks
//     there is no mechanical close short of recording per-tier seconds into `meta`, and that edit
//     is in `MEASURED_PATHS` and owes a full bench.
//   - Outside `.claude/commands/**` the rule is still "dated or deferred", and a date in a dated
//     LOG is not checked for freshness — a historical incident is not a stale price, and no
//     measured threshold separates them.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const COMMANDS_DIR = join(ROOT, '.claude', 'commands');
const WORKFLOWS_DIR = join(ROOT, '.claude', 'workflows');
const DOCS_DIR = join(ROOT, 'docs');
const BENCH_COST_DOC = join(DOCS_DIR, 'bench-cost.md');
const DISCIPLINE_DOC = join(DOCS_DIR, 'measurement-discipline.md');
const ARTIFACT = join(ROOT, 'apps', 'benchmark', 'results', 'results.json');

/** The two prompts that drive a measured round. `dogfood-klonoa.md` and `update-m2c.md` are not in
 *  the duplication pair: they describe different workflows and share no phase structure. They ARE
 *  in the link check below — sharing the LAWS is not sharing a phase structure. */
const PAIR = ['match-function.md', 'attribute-function.md'];

/** Lines 1-8 of the PAIR: the frontmatter, the `Target function: **$1**` line and the "if it is
 *  empty, ask" instruction — the one place sharing text is the point rather than a drift hazard.
 *  Shared by this pair only; of the six command-file pairs the other five share no run at all.
 *  The identical run ends at line 8 (line 9 is blank in both), so 8 is its exact end: 6 already
 *  clears the run's substantive lines, and 10 hides the first line of real prose in each file. */
const PREAMBLE_LINES = 8;

const commandFiles = () => readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
/** The brief GENERATORS. Every JS extension, not just `.js`: a rename to `.mjs` would otherwise
 *  empty the `${REPO}` describe below, and a per-directory loop that finds no files is a green,
 *  EMPTY describe rather than a failure. Every directory loop in this file has a canary. */
const briefGenerators = () => readdirSync(WORKFLOWS_DIR).filter((f) => /\.(m|c)?js$/.test(f));
const docFiles = () =>
  readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(DOCS_DIR, f));
const read = (f: string) => readFileSync(join(COMMANDS_DIR, f), 'utf8').split('\n');
/** One cell of a markdown table row. `row.split('|')` puts the leading `|` before index 1, so cell
 *  1 is the command, 2 the cost and 3 the provenance. */
const cellOf = (row: string, n: number) => row.split('|')[n] ?? '';
const substantive = (l: string) => l.trim().length > 20;

/** The longest run of consecutive identical lines (ignoring indentation) shared by two files,
 *  counted only where the run carries at least `minSubstantive` lines of real prose — a run of
 *  blank lines and `- ` bullets is not a duplicated instruction. */
function longestSharedRun(a: string[], b: string[], minSubstantive = 2) {
  const norm = (l: string) => l.trim();
  const index = new Map<string, number[]>();
  b.forEach((l, j) => index.set(norm(l), [...(index.get(norm(l)) ?? []), j]));
  let best = { length: 0, aLine: 0, bLine: 0, text: '' };
  for (let i = 0; i < a.length; i++) {
    for (const j of index.get(norm(a[i])) ?? []) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && norm(a[i + k]) === norm(b[j + k])) {
        k++;
      }
      const run = a.slice(i, i + k);
      if (k > best.length && run.filter(substantive).length >= minSubstantive) {
        best = { length: k, aLine: i + 1, bLine: j + 1, text: run.find(substantive) ?? run[0] ?? '' };
      }
    }
  }
  return best;
}

describe('the two round prompts do not duplicate an instruction', () => {
  it('shares no run of 3+ consecutive lines below the preamble', () => {
    const [a, b] = PAIR.map((f) => read(f).slice(PREAMBLE_LINES));
    const run = longestSharedRun(a, b);
    expect(
      run.length < 3,
      `${PAIR[0]}:${run.aLine + PREAMBLE_LINES} and ${PAIR[1]}:${run.bLine + PREAMBLE_LINES} share ` +
        `${run.length} identical lines starting "${run.text.trim().slice(0, 70)}". ` +
        `Move the shared instruction into a doc under docs/ and link it from both.`,
    ).toBe(true);
  });

  it('neither prompt carries a cost table of its own', () => {
    for (const f of PAIR) {
      const text = read(f).join('\n');
      expect(text, `${f} carries a cost table — it belongs in docs/bench-cost.md`).not.toMatch(
        /\|\s*command\s*\|\s*cost\s*\|/i,
      );
    }
  });

  it('every command file links the two shared docs', () => {
    expect(
      commandFiles().length,
      'no command files found — the directory moved and this suite went blind',
    ).toBeGreaterThanOrEqual(4);
    for (const f of commandFiles()) {
      const text = read(f).join('\n');
      for (const doc of ['docs/bench-cost.md', 'docs/measurement-discipline.md']) {
        expect(text, `${f} does not link ${doc} — the laws and the costs are shared by every round`).toContain(doc);
      }
    }
  });
});

describe('a verdict that ENDS a round is linked to its evidence', () => {
  // WHY THIS SHAPE, and not either of the two obvious ones. This gate has now been disarmed twice
  // by its own corpus, and both defeats are encoded below.
  //
  //   DEFEAT 1 — the wrong KEY. The first version keyed on the word `precedent`, which the SAME
  //   BRANCH's earlier commit had already deleted from the bullet the gate protects. It examined 0
  //   of 175 blocks, so `unbacked` was `[]` unconditionally: green with the evidence link DELETED.
  //   Fix: key on the RULE (a verdict that tells the agent to stop), require a MARKDOWN link
  //   (the sibling link-resolution suite below only inspects `](…)`, so a bare `docs/foo.md` in
  //   running text is an unchecked promise), and assert the scan examined something.
  //
  //   DEFEAT 2 — the wrong UNIT, which then propped up the count from defeat 1. Blocks were
  //   blank-line delimited, so `## Hard rules`' five numbered items were ONE block: it carries the
  //   word `unmatchable` (rule 4) and a `docs/measurement-discipline.md` link (rule 5), which has
  //   nothing to do with any verdict. That decoy satisfied `examined > 0` on its own, so rewording
  //   the Phase-1 outcome bullet and deleting its link — the exact regression — was green again.
  //   Three independent existentials over an 18-line paragraph is not a rule about a verdict.
  //
  // Hence: the unit is the BULLET (a top-level `-`/`N.` item plus its continuation lines), the link
  // must be in the bullet that carries the verdict, and the assertion on the corpus is the pinned
  // INHABITANT SET below rather than a count. A count can be held up by anything; a named set
  // cannot. `registerBacked` is a third, non-redundant check: re-pointing every verdict at some
  // other `docs/` page keeps the set intact and the unbacked list empty while leaving the register
  // itself unreferenced (#186: a stamp needs a test where it is produced).
  const STOPS = /\bstops?\b/i;
  const VERDICT = /\bunmatchable\b|\bquirks?\b/i;
  const DOC_LINK = /\]\([^)\s]*docs\/[\w.-]+\.md[^)\s]*\)/;
  const REGISTER_LINK = /\]\([^)\s]*docs\/unmatchable-quirks\.md[^)\s]*\)/;
  const BULLET = /^(?:[-*+]|\d+\.)\s/;

  /** Every verdict bullet that must carry an evidence link today, `file: label`. A verdict that is
   *  reworded away drops out of this set and reddens the file; a NEW one has to be added here on
   *  purpose, which is where an author is asked whether it is backed. Labels are the bullet's bold
   *  lead, not line numbers — those rot on the next edit above them. */
  const PINNED = ['match-function.md: Unmatchable source quirk', 'match-function.md: Stop rule.'];

  /** The units a verdict can live in: a top-level bullet or numbered rule with its continuation
   *  lines, and (for text that is not a list) a blank-line-delimited paragraph. */
  const verdictUnits = (lines: string[]) => {
    const units: { line: number; body: string[] }[] = [];
    const pushBlock = (block: string[], base: number) => {
      let s = 0;
      for (let i = 0; i <= block.length; i++) {
        if (i < block.length && !(i > s && BULLET.test(block[i]))) {
          continue;
        }
        if (i > s) {
          units.push({ line: base + s + 1, body: block.slice(s, i) });
        }
        s = i;
      }
    };
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      if (i < lines.length && lines[i].trim() !== '') {
        continue;
      }
      if (i > start) {
        pushBlock(lines.slice(start, i), start);
      }
      start = i + 1;
    }
    return units;
  };

  /** Units of `lines` that pronounce a row unmatchable AND tell the agent to stop. Returns WHICH
   *  were examined, not just how many — a gate over an empty set is a comment with a test runner
   *  attached, and a gate over an unnamed set is one a decoy can keep alive. */
  const scanStops = (lines: string[], file = '<fixture>') => {
    const unbacked: string[] = [];
    const examined: { file: string; label: string; line: number }[] = [];
    let registerBacked = 0;
    for (const unit of verdictUnits(lines)) {
      const text = unit.body.join(' ');
      if (!VERDICT.test(text) || !STOPS.test(text)) {
        continue;
      }
      const label = (unit.body[0].match(/\*\*(.+?)\*\*/)?.[1] ?? unit.body[0].trim().slice(0, 60)).trim();
      examined.push({ file, label, line: unit.line });
      if (REGISTER_LINK.test(text)) {
        registerBacked++;
      }
      if (!DOC_LINK.test(text)) {
        unbacked.push(`${file}:${unit.line}: ${unit.body[0].trim().slice(0, 70)}`);
      }
    }
    return { examined, unbacked, registerBacked };
  };

  it('every unmatchable verdict in a command file links a docs/ page', () => {
    const examined: { file: string; label: string; line: number }[] = [];
    const unbacked: string[] = [];
    let registerBacked = 0;
    for (const f of commandFiles()) {
      const found = scanStops(read(f), f);
      examined.push(...found.examined);
      unbacked.push(...found.unbacked);
      registerBacked += found.registerBacked;
    }
    expect(unbacked, `a verdict that stops the round, with no evidence link: ${unbacked.join(' | ')}`).toEqual([]);
    expect(
      examined.map((e) => `${e.file}: ${e.label}`).sort(),
      'the set of verdict bullets this gate protects has changed. MISSING entry: a bullet that told ' +
        'an agent a row is unmatchable and to stop no longer reads that way — if that was deliberate, ' +
        'delete it from PINNED; if not, this is the regression the gate exists to catch. EXTRA entry: ' +
        'a new verdict that ends a round — add it to PINNED once it links its evidence.',
    ).toEqual([...PINNED].sort());
    expect(
      registerBacked,
      'no verdict bullet links docs/unmatchable-quirks.md any more. Every one of them is backed by ' +
        'SOME docs page, so the check above is green — but the register that holds the cleared rows ' +
        'is now unreachable from the prompts, which is how it stops being read.',
    ).toBeGreaterThan(0);
  });

  it('fires on a verdict whose evidence link is missing, and only then', () => {
    const bullet = [
      '- **Unmatchable source quirk** — the original C used a construct no honest recovery would',
      '  produce. Say so, prove it, and stop.',
    ];
    const unlinked = scanStops(bullet);
    expect(unlinked.examined.map((e) => e.label)).toEqual(['Unmatchable source quirk']);
    expect(unlinked.unbacked).toHaveLength(1);
    expect(unlinked.unbacked[0]).toContain('<fixture>:1: - **Unmatchable source quirk**');
    const backed = [
      bullet[0],
      `${bullet[1]} The bar is [\`docs/unmatchable-quirks.md\`](../../docs/unmatchable-quirks.md).`,
    ];
    expect(scanStops(backed).unbacked).toEqual([]);
    expect(scanStops(backed).registerBacked).toBe(1);
    // A bare path in prose is NOT a link: nothing downstream checks it resolves.
    const prose = [bullet[0], `${bullet[1]} The bar is docs/unmatchable-quirks.md.`];
    expect(scanStops(prose).unbacked).toHaveLength(1);
    // Some other docs page is a link but not the register: backed, not register-backed.
    const elsewhere = [bullet[0], `${bullet[1]} The bar is [\`docs/bench-cost.md\`](../../docs/bench-cost.md).`];
    expect(scanStops(elsewhere).unbacked).toEqual([]);
    expect(scanStops(elsewhere).registerBacked).toBe(0);
  });

  it('does not let a neighbouring rule back a verdict — the defeat-2 shape', () => {
    // `## Hard rules` verbatim in shape: one blank-line block, five numbered items, the verdict in
    // item 2 and an unrelated docs link in item 3. Under the old block unit this scanned as ONE
    // backed block — examined 1, unbacked 0, and the count kept the whole gate alive.
    const rules = [
      '1. **Never trade a loud failure for a silent wrong answer.** Every new transform must state',
      '   the condition under which it refuses.',
      '2. **Stop rule.** If the capability is bigger than this session, or the row turns out',
      '   unmatchable: keep and ship the commits that genuinely reduced the diff.',
      '3. **Everything in [`docs/measurement-discipline.md`](../../docs/measurement-discipline.md)**',
      '   — numbers come from commands; a measured null ships.',
    ];
    const scanned = scanStops(rules, 'hard-rules');
    expect(scanned.examined.map((e) => e.label)).toEqual(['Stop rule.']);
    expect(scanned.unbacked).toHaveLength(1);
    expect(scanned.unbacked[0]).toContain('hard-rules:3:');
    expect(scanned.registerBacked).toBe(0);
  });
});

describe('the unmatchable register is falsified by the artifact', () => {
  // The register says of itself that "an entry here closes a row to future rounds and that is
  // exactly the kind of claim that rots unwatched", and it shipped with no gate — while the cost
  // table 170 lines above has one. A verdict does not rot on a CLOCK the way a cost figure does; it
  // rots the instant somebody matches the row. `results.json` knows, and `citations.test.ts` already
  // holds the ids in this page to rows that exist, so the only thing missing is the one assertion
  // the entry's own falsification condition names.
  const REGISTER = join(DOCS_DIR, 'unmatchable-quirks.md');
  const ROW_ID = /^\|\s*`([\w.-]+:[\w.-]+:[\w.-]+)`\s*\|/;

  const registerRows = () =>
    readFileSync(REGISTER, 'utf8')
      .split('\n')
      .map((l) => l.match(ROW_ID)?.[1])
      .filter((id): id is string => Boolean(id));

  it('every row it closes is still a nonmatch in results.json', () => {
    const ids = registerRows();
    expect(
      ids.length,
      `no row parsed out of ${REGISTER}'s table — either the register is empty (delete this gate) or ` +
        'its table shape moved and this check went blind',
    ).toBeGreaterThan(0);

    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8')).results as {
      id: string;
      asmlift?: { outcome?: string };
    }[];
    const falsified: string[] = [];
    for (const id of ids) {
      const row = artifact.find((r) => r.id === id);
      expect(row, `${REGISTER} closes ${id}, which is not a row in the committed results.json`).toBeDefined();
      if (row?.asmlift?.outcome === 'match') {
        falsified.push(id);
      }
    }
    expect(
      falsified,
      `the register calls these rows unmatchable and the artifact says asmlift matched them. An entry ` +
        `is falsified by one honest spelling reaching the target bytes, and a published match IS one: ` +
        `delete the entry, do not annotate it. ${falsified.join(', ')}`,
    ).toEqual([]);
  });
});

describe('every link in a command file resolves', () => {
  // Both spellings: `](../../docs/x.md)` relative to the file, and `](docs/x.md)` relative to the
  // repo root. Matching only the leading-`.` form leaves a repo-root link that 404s invisible, and
  // that is the spelling an author reaches for by habit.
  const LINK = /\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g;
  const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
  for (const f of commandFiles()) {
    it(f, () => {
      const broken: string[] = [];
      readFileSync(join(COMMANDS_DIR, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(LINK)) {
            const href = m[1];
            if (EXTERNAL.test(href)) {
              continue;
            }
            const base = href.startsWith('.') ? dirname(join(COMMANDS_DIR, f)) : ROOT;
            if (!existsSync(resolve(base, href))) {
              broken.push(`${f}:${i + 1} → ${href}`);
            }
          }
        });
      expect(broken, `dead link(s): ${broken.join(', ')}`).toEqual([]);
    });
  }
});

/** The rows of "## 1. The table". Read inside the `it`s, not at describe scope: against a tree
 *  without the doc, a describe-scope `readFileSync` throws an ENOENT stack and vitest reports
 *  "no tests" — red, but with every diagnosis this suite exists to print unreachable. */
function tableRows() {
  if (!existsSync(BENCH_COST_DOC)) {
    return { missing: true as const, rows: [] as string[] };
  }
  const lines = readFileSync(BENCH_COST_DOC, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^##\s+1\./.test(l));
  if (start === -1) {
    return { missing: false as const, rows: [] as string[] };
  }
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const rows = lines
    .slice(start, end === -1 ? lines.length : end)
    .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !/\|\s*command\s*\|/i.test(l));
  return { missing: false as const, rows };
}

describe('docs/bench-cost.md', () => {
  // Not global: `RegExp.test` on a `/g` literal carries `lastIndex` between calls and would skip
  // every second dated row.
  const DATE = /\b20\d\d-\d\d-\d\d\b/;
  const datesIn = (s: string) => [...s.matchAll(/\b20\d\d-\d\d-\d\d\b/g)].map((m) => Date.parse(m[0]));

  /** The `NOT re-measured` escape belongs to the rows this repo is FORBIDDEN to measure: HARD
   *  RULE 1's LoadBGTilemapData ranked run, whose fan `fan.ts` prices at over five hours. The row
   *  it is claimed on must NAME that run in its command cell, because a phrase honoured on any row
   *  exempts any figure from both the dating and the freshness test in a one-word edit. Anything
   *  else must carry a date, and a claim of the escape elsewhere is reported rather than ignored. */
  const UNMEASURABLE = /LoadBGTilemapData/;
  const honestlyHistorical = (row: string) => row.includes('NOT re-measured') && UNMEASURABLE.test(cellOf(row, 1));
  const escapeAbused = (row: string) => row.includes('NOT re-measured') && !UNMEASURABLE.test(cellOf(row, 1));

  it('dates every figure in the cost table', () => {
    const { missing, rows } = tableRows();
    expect(missing, 'docs/bench-cost.md is gone — the prompts link it and it is the only cost table').toBe(false);
    expect(rows.length, 'no table rows found under "## 1." — the section moved or was renamed').toBeGreaterThan(5);
    const undated = rows.filter((l) => !DATE.test(l) && !honestlyHistorical(l));
    expect(
      undated,
      'a cost with no measured date reads as current forever — add the date, or, if HARD RULE 1 forbids ' +
        'measuring the row at all, mark it "NOT re-measured"',
    ).toEqual([]);
    expect(
      rows.filter(escapeAbused),
      'the "NOT re-measured" escape is for the rows this repo may not measure (the LoadBGTilemapData ' +
        'ranked run). On any other row it is an undated figure with a licence — date it instead.',
    ).toEqual([]);
  });

  /** A DATE IS NOT FRESHNESS. Measured against the artifact's own `meta.generatedAt` rather than
   *  `Date.now()`: that clock moves only when somebody published a benchmark run, so this fails
   *  for the person who just paid for the measurement (and can re-date the row in seconds) and
   *  never for a PR that ran no bench. The doc's §2 states the bound this encodes — "a cost figure
   *  for [the real tier] older than about a week is fiction". */
  const FULL_RUN_DAYS = 8;
  const OTHER_DAYS = 120;

  it('no row in the cost table is older than the artifact it prices', () => {
    const { missing, rows } = tableRows();
    if (missing) {
      return;
    } // the test above is the one that reports this
    const meta = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
    const artifactAt = Date.parse(meta.meta.generatedAt);
    expect(Number.isFinite(artifactAt), 'results.json has no parseable meta.generatedAt').toBe(true);

    const stale: string[] = [];
    for (const row of rows) {
      if (honestlyHistorical(row)) {
        continue;
      } // a figure HARD RULE 1 forbids re-taking; the dating test owns the abuse of this escape
      // THE FIGURE'S OWN CELL DECIDES. `Math.max` over the whole row let a figure dated eight
      // months stale ride a fresh date in the neighbouring provenance cell — and §1's rows
      // routinely carry several (the `--tier real` row cites four). So: if the COST cell carries a
      // date, that date is the figure's date and nothing else in the row can rescue it. Only when
      // the cost cell is dateless — today, every row — does the rest of the row answer.
      const inCostCell = datesIn(cellOf(row, 2));
      const dates = inCostCell.length > 0 ? inCostCell : datesIn(row);
      if (dates.length === 0) {
        continue;
      } // the dating test above owns that case
      const newest = Math.max(...dates);
      const ageDays = (artifactAt - newest) / 86_400_000;
      // The rows that price a whole tier are the ones §2 measured growing 4.3x in 17 days.
      const limit = /bench run|bench:merge/.test(row) ? FULL_RUN_DAYS : OTHER_DAYS;
      if (ageDays > limit) {
        stale.push(`${Math.round(ageDays)}d old (limit ${limit}d): ${row.trim().slice(0, 90)}`);
      }
    }
    expect(
      stale,
      `a row in docs/bench-cost.md §1 is older than the committed artifact (generated ${meta.meta.generatedAt}) ` +
        `by more than its bound. You are publishing a run — re-measure the row and move its date, or, if you ` +
        `cannot, delete the row rather than let it read as current.`,
    ).toEqual([]);
  });

  /** §3 IS DERIVABLE, so it is derived rather than read. Every figure in "Answer the cost question
   *  without running a bench" is a field of the committed artifact — `rankSeconds` and
   *  `candidateCount`, summed by tier — and `tableRows()` scopes to `## 1.`, so the two tests above
   *  see none of them. The repo's own rule is that a pass may be half-converted to a table provided
   *  the residue is NAMED: the residue here is the three wall clocks in §1's first rows, which come
   *  from run logs and not from the artifact (`meta` carries `generatedAt`, `counts`, `toolchains`
   *  and the two commits, and no duration). */
  it('§3 quotes the artifact it says it is summed out of', () => {
    if (!existsSync(BENCH_COST_DOC)) {
      return;
    } // the dating test reports a missing doc
    const doc = readFileSync(BENCH_COST_DOC, 'utf8').split('\n');
    const start = doc.findIndex((l) => /^##\s+3\./.test(l));
    expect(start, 'docs/bench-cost.md has no "## 3." — the section moved or was renamed').toBeGreaterThan(-1);
    const end = doc.findIndex((l, i) => i > start && /^##\s/.test(l));
    const text = doc.slice(start, end === -1 ? doc.length : end).join(' ');

    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
    const ranked = (tier: string) =>
      artifact.results.filter((r: { tier: string; asmlift?: { rankSeconds?: number } }) => {
        return r.tier === tier && typeof r.asmlift?.rankSeconds === 'number';
      });
    const sum = (rows: { asmlift: { rankSeconds: number } }[]) => rows.reduce((a, r) => a + r.asmlift.rankSeconds, 0);
    const row = (id: string) => artifact.results.find((r: { id: string }) => r.id === id);
    const group = (n: number) => Math.round(n).toLocaleString('en-US');

    const real = ranked('real');
    const synthetic = ranked('synthetic');
    const piue = row('kleod:ProcessInputAndUpdateEntities:agbcc');
    const ccg = row('kleod:CountCollectedGems:agbcc');

    const expected = [
      `${group(sum(real))} s over ${real.length}`,
      `${group(sum(synthetic))} s over ${synthetic.length}`,
      `${group(piue.asmlift.rankSeconds)} s`,
      `${Math.round((piue.asmlift.rankSeconds / sum(real)) * 100)}% of the tier`,
      `fan=${ccg.asmlift.candidateCount} rank=${ccg.asmlift.rankSeconds.toFixed(1)}s`,
    ];
    const missing = expected.filter((e) => !text.includes(e));
    expect(
      missing,
      `docs/bench-cost.md §3 disagrees with apps/benchmark/results/results.json. Every figure there is ` +
        `derived from the artifact, so re-read it rather than re-typing it — expected: ${expected.join(' · ')}`,
    ).toEqual([]);
  });
});

/** Everything under `.claude/` an agent or a brief author reads: the four command files, the
 *  workflow brief generator and its ledger. Deliberately NOT a walk of all of `.claude/` — that
 *  includes the gitignored `.claude/worktrees/`, which would make a committed gate's verdict depend
 *  on untracked local content and let CI and a developer machine disagree. */
function claudeFiles(): string[] {
  const out: string[] = [];
  for (const dir of [COMMANDS_DIR, WORKFLOWS_DIR]) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.(md|(m|c)?js)$/.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

/** A sentence that puts a wall-clock number on a harness or test command.
 *
 *  `COMMAND` is every command the prompts actually price, not only the full-bench ones: an
 *  enumeration rate, a ranked run, `bench fan`, `bench gates` and `npx vitest run` each carry a
 *  figure a prompt is tempted to copy, and a vocabulary narrower than that sees none of them.
 *
 *  `AMOUNT` pins the RULE and not the spelling: a figure written in words ("is over five hours to
 *  score") is the same claim as one written in digits, and the one figure HARD RULE 1 forbids
 *  re-measuring is spelled that way. */
const AMOUNT = String.raw`(?:\b(?:~|about |over |under )?\d[\d,.]*|\b(?:half an|one|two|three|four|five|six|seven|eight|nine|ten)\s)\s*`;
const UNIT = String.raw`(?:s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|ms)\b`;
const COMMAND = String.raw`(?:pnpm |npx )?(?:bench[: ](?:run|merge|fan|sweep|gates|baseline|repro|target|diff|regression|setup|fidelity|smoke|verify|publish|vendor|stale-check|in-flight)|full bench|ranked run|ranked enumeration|vitest|test:matching|test:offline)`;

/** BOTH ORDERS, because English writes it either way: "Budget ~34 min for a full `pnpm bench run`"
 *  and "A full `pnpm bench run` takes ~34 min" are one claim with the clauses swapped, so requiring
 *  the COMMAND token first sees only half the cost sentences a writer reaches for. */
const BENCH_COST = new RegExp(
  `(?:${COMMAND}[^\\n]{0,140}?${AMOUNT}${UNIT})|(?:${AMOUNT}${UNIT}[^\\n]{0,140}?${COMMAND})`,
  'i',
);

describe('a harness cost is written in one place', () => {
  /** THE PROMPTS MAY NOT CARRY A FIGURE AT ALL — not even a freshly dated one. A date does not
   *  stop a copy drifting; only not having a copy does, and §2 shows the fan counts moving fastest
   *  of all. So inside `.claude/commands/**` the deferral is the whole legal spelling: name the
   *  command, link `docs/bench-cost.md`, quote nothing. This is the rule the prompts themselves
   *  STATE ("Do not retype one of those numbers here"), enforced. */
  it('no command file quotes a harness wall clock — the prompts defer, they do not copy', () => {
    const copies: string[] = [];
    for (const f of commandFiles()) {
      read(f).forEach((line, i) => {
        if (BENCH_COST.test(line)) {
          copies.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(
      copies,
      'a harness cost inside a prompt is a copy of a docs/bench-cost.md cell and drifts the day the table ' +
        'is re-measured — say "a full `pnpm bench run` is the expensive one (docs/bench-cost.md §1)" and let ' +
        'the reader follow the link. The table is the only place a figure lives.',
    ).toEqual([]);
  });

  /** …AND NOT A CELL OF §1 ANYWHERE IN THE FILE, on any line, however it is worded. The rule above
   *  needs the command and the figure on one line, and a prompt that copies a cell typically sits
   *  it a line away from the command it prices. So the banned set is DERIVED from §1's own cost
   *  cells: whatever number the table currently states, no prompt may state it. One list, no
   *  second copy to drift.
   *
   *  Widening the sentence rule to paragraph scope instead over-fires rather than narrowing:
   *  joining a multi-line bullet into one window pairs a command with an unrelated number tens of
   *  lines away. Over the four prompts it matches four paragraphs and not one of them states a §1
   *  cost cell. There is no threshold there; there is an exact list here. */
  const figure = /(\d[\d,.]*)\s*(ms|s|sec|secs|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/gi;
  const normalize = (text: string) =>
    [...text.matchAll(figure)].map((m) => `${m[1].replace(/[.,]$/, '')} ${m[2].toLowerCase()}`);

  it('no command file states a figure docs/bench-cost.md §1 already states', () => {
    const { rows } = tableRows();
    const priced = new Set(rows.flatMap((r) => normalize(cellOf(r, 2))));
    expect(priced.size, 'no figures parsed out of §1’s cost column — the table shape changed').toBeGreaterThan(5);

    const copies: string[] = [];
    for (const f of commandFiles()) {
      read(f).forEach((line, i) => {
        for (const fig of normalize(line)) {
          if (priced.has(fig)) {
            copies.push(`${f}:${i + 1}  "${fig}"  ${line.trim().slice(0, 70)}`);
          }
        }
      });
    }
    expect(
      copies,
      'a prompt states a figure that is a cell of docs/bench-cost.md §1. That is the retyped-cost defect ' +
        'by definition: the table moves and the copy does not. Name the command and link the table.',
    ).toEqual([]);
  });

  /** `docs/` is where the cost prose lives once the prompts defer to it, so it is where an undated
   *  figure does the most damage — a guard aimed only at `.claude/commands/**` is aimed away from
   *  the material. The shape to catch: a doc pricing a scoped confirm run at a flat handful of
   *  seconds while the artifact records that row in the thousands. `docs/bench-cost.md` §1 is
   *  excluded because the two tests above own it. */
  function bench_cost_section_1(file: string): [number, number] {
    if (file !== BENCH_COST_DOC) {
      return [-1, -1];
    }
    const lines = readFileSync(file, 'utf8').split('\n');
    const start = lines.findIndex((l) => /^##\s+1\./.test(l));
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    return [start, end === -1 ? lines.length : end];
  }

  it('every wall-clock claim in docs/ or a workflow brief carries a date or defers to docs/bench-cost.md', () => {
    const undated: string[] = [];
    for (const file of [...claudeFiles().filter((f) => !f.startsWith(COMMANDS_DIR)), ...docFiles()]) {
      const [s1from, s1to] = bench_cost_section_1(file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!BENCH_COST.test(line) || (i >= s1from && i < s1to)) {
          return;
        }
        // The date may sit anywhere in the same PARAGRAPH — the contiguous run of non-blank lines
        // around this one — and so may the deferral. A fixed +/-2 window was too tight for a
        // multi-line list item: the ledger dates entry #82 on its first line and prices the
        // incident on its fourth, which is one claim with one date, not an undated one.
        let from = i;
        while (from > 0 && lines[from - 1].trim() !== '') {
          from--;
        }
        let to = i;
        while (to < lines.length - 1 && lines[to + 1].trim() !== '') {
          to++;
        }
        const context = lines.slice(from, to + 1).join('\n');
        if (/\b20\d\d-\d\d-\d\d\b/.test(context) || context.includes('docs/bench-cost.md')) {
          return;
        }
        undated.push(`${file.slice(ROOT.length + 1)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    expect(
      undated,
      'a bench cost with no measured date beside it reads as current forever — date it, or point at docs/bench-cost.md',
    ).toEqual([]);
  });
});

describe('the harness commands the docs name are the ones that exist', () => {
  /** The dispatch in `apps/benchmark/src/cli.ts` is the authority, so the list is read from it
   *  rather than copied — two copies of a list like this drift, and the drift is only ever found
   *  by the gate that should have fired. */
  const subcommands = new Set(
    [...readFileSync(join(ROOT, 'apps', 'benchmark', 'src', 'cli.ts'), 'utf8').matchAll(/case '([a-z][a-z-]*)'/g)].map(
      (m) => m[1],
    ),
  );

  const MENTION = /(?:pnpm bench|`bench) ([a-z][a-z-]*)/g;
  const sources = [
    ...claudeFiles(),
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(ROOT, 'docs', f)),
  ];

  it('the dispatch was readable', () => {
    expect(subcommands.size, 'no `case` labels found in apps/benchmark/src/cli.ts — the parse broke').toBeGreaterThan(
      10,
    );
  });

  it('names no subcommand the dispatch does not have', () => {
    const ghosts: string[] = [];
    for (const file of sources) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(MENTION)) {
            if (!subcommands.has(m[1])) {
              ghosts.push(`${file.slice(ROOT.length + 1)}:${i + 1} → pnpm bench ${m[1]}`);
            }
          }
        });
    }
    expect(
      ghosts,
      'a doc names a `pnpm bench` subcommand the dispatch does not have. #192 changed four commands ' +
        'and no prompt was updated; writing a proposed-but-unbuilt command into a spec is the same defect ' +
        `in the other direction. The dispatch has: ${[...subcommands].sort().join(', ')}`,
    ).toEqual([]);
  });
});

describe('the workflow brief generator sends nobody to the frozen checkout', () => {
  /** `REPO` in `meta-optimizer-loop.js` is the USER's checkout, which is routinely tens of commits
   *  behind main — 0b30aebe vs 8599234d on 2026-09-12, with its copy of the ledger still carrying a
   *  bench cost that had already been corrected on main. A `${REPO}/<path>` handed to an agent as a
   *  READ path is therefore a stale read; `git -C ${REPO} show origin/main:<path>` is not, and the
   *  SUPERVISOR — which gets no worktree of its own — has no other way to read the current spec. */
  const rooted = /\$\{REPO\}\/[A-Za-z_.]|\bjoin\(\s*REPO\s*,|\bresolve\(\s*REPO\s*,/;

  it('found a brief generator to check', () => {
    expect(
      briefGenerators(),
      'no brief generator found in .claude/workflows — a per-file loop with no files is a green, EMPTY ' +
        'describe, so a rename out of the extension set below silently retires the check that keeps ' +
        'frozen-checkout read paths out of the briefs.',
    ).not.toEqual([]);
  });

  for (const file of briefGenerators()) {
    it(file, () => {
      const hits: string[] = [];
      readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (rooted.test(line)) {
            hits.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
          }
        });
      expect(
        hits,
        "a ${REPO}-rooted file path in a brief sends the agent to the user's frozen checkout — " +
          '16 of 21 spec reads across rounds #183-#188 landed there. Read from the ref instead: ' +
          '`git -C ${REPO} fetch origin && git -C ${REPO} show origin/main:<path>`, or give the agent its own worktree.',
      ).toEqual([]);
    });
  }
});

describe('a spec does not state a cardinality for a list it links', () => {
  /** A round diagnosed "a round handed a SHORT VERSION of the `pr-wait.sh` exit codes has no
   *  reading for the two that mean STOP WAITING", widened §8 from four rows to six — and in the
   *  SAME commit wrote "`docs/measurement-discipline.md` §8 has its FOUR exit codes" into a prompt,
   *  now with the doc's authority behind it. That is the structural cost of the duplication gate:
   *  its only enforceable remedy for shared text is "make the two files differ", and it cannot tell
   *  move-to-doc from reword. A count is the smallest possible copy of a list, and it goes stale
   *  the first time the list grows. Link the list; do not count it. */
  it('no command file counts the exit codes of a script it links', () => {
    const counted: string[] = [];
    const CARDINALITY = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+){0,2}exit codes?\b/i;
    for (const f of commandFiles()) {
      read(f).forEach((line, i) => {
        if (CARDINALITY.test(line)) {
          counted.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(
      counted,
      'a prompt states how many exit codes the linked doc lists. It was four, the doc grew to six in the ' +
        'commit that wrote the sentence, and nothing noticed. Say "its exit codes" and let the table be the list.',
    ).toEqual([]);
  });

  /** …and the table itself is checked against the script, both ways, so the doc cannot be the thing
   *  that goes short either. */
  it('docs/measurement-discipline.md §8 lists exactly the codes pr-wait.sh exits with', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'pr-wait.sh'), 'utf8');
    // `^\s*exit N` — a STATEMENT. The script's header block also discusses `gh`'s own documented
    // codes in prose, and those are not codes `pr-wait.sh` returns.
    const codes = new Set([...script.matchAll(/^[ \t]*exit ([0-9]+)/gm)].map((m) => m[1]));
    expect(codes.size, 'no `exit N` statements found in scripts/pr-wait.sh — the parse broke').toBeGreaterThan(3);

    const doc = readFileSync(DISCIPLINE_DOC, 'utf8').split('\n');
    const start = doc.findIndex((l) => /^##\s+8\./.test(l));
    expect(start, 'docs/measurement-discipline.md has no "## 8." — the section moved or was renamed').toBeGreaterThan(
      -1,
    );
    const end = doc.findIndex((l, i) => i > start && /^##\s/.test(l));
    const documented = new Set(
      doc
        .slice(start, end === -1 ? doc.length : end)
        .map((l) => /^\|\s*([0-9]+)\s*\|/.exec(l)?.[1])
        .filter((c): c is string => c !== undefined),
    );
    const byNumber = (a: string, b: string) => Number(a) - Number(b);
    expect(
      [...documented].sort(byNumber),
      'docs/measurement-discipline.md §8 and scripts/pr-wait.sh disagree about the exit codes. The script ' +
        'is the authority; a round handed a short version has no reading for the codes that mean stop waiting.',
    ).toEqual([...codes].sort(byNumber));
  });
});

describe('the fourth Phase-0 case is a command a round can run', () => {
  /** `docs/baseline-freshness.md` told a round to check `git diff --name-only origin/main...HEAD --
   *  $(scoring paths)`, which is a PROSE PLACEHOLDER — no command, env var or flag prints that
   *  list — and then banned hand-copying it six lines later. The only runnable form it left was
   *  `git status --porcelain`, which has no path filter: six untracked `.bin` files in the user's
   *  own checkout put a round in case 4 and order a scoped re-measure, which `docs/bench-cost.md`
   *  §1 prices at the ROW's own cost — three orders of magnitude across this tier. The doc gives a
   *  one-liner that DERIVES the list from the export, and this is the gate that it still finds it. */
  it('the SCORING_PATHS literal is extractable in the shape docs/baseline-freshness.md extracts it', async () => {
    const src = readFileSync(join(ROOT, 'apps', 'benchmark', 'src', 'provenance.ts'), 'utf8').split('\n');
    const start = src.findIndex((l) => /^export const SCORING_PATHS = \[/.test(l));
    const end = src.findIndex((l, i) => i > start && /^\];/.test(l));
    expect(
      start,
      'no `export const SCORING_PATHS = [` in provenance.ts — the doc one-liner extracts nothing',
    ).toBeGreaterThan(-1);
    const extracted = src
      .slice(start, end === -1 ? src.length : end)
      .flatMap((l) => [...l.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const { SCORING_PATHS } = await import('../src/provenance');
    expect(
      extracted,
      'the `sed`/`grep` derivation docs/baseline-freshness.md §3 hands a round no longer yields SCORING_PATHS. ' +
        'Fix the doc rather than let it print a pathspec that matches nothing — in zsh that reads as "go ahead".',
    ).toEqual(SCORING_PATHS);
  });
});
