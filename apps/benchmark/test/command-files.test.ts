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
//      the moment the doc was written. When it becomes 45, two of the three drift. A full-bench
//      wall clock is therefore illegal inside a prompt — link the table, do not copy a cell out.
//   5. A LINK THAT DOES NOT RESOLVE. The prompts delegate half their content to `docs/`; a link
//      that 404s sends the agent back to inference.
//   6. A GHOST SUBCOMMAND. #192 changed four `pnpm bench` commands and no prompt was updated; the
//      dispatch in `apps/benchmark/src/cli.ts` is the authority on which ones exist.
//   7. A PATH INTO THE USER'S FROZEN CHECKOUT. The workflow brief generator handed its agents
//      `${REPO}/.claude/...`; 16 of 21 spec reads across rounds #183-#188 landed on text tens of
//      commits stale. A ref (`git show origin/main:<path>`) cannot go stale; a path there always can.
//
// It cannot check that an instruction is TRUE — only a command run can. What it holds is the shape
// that lets one file be the place a correction lands.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const COMMANDS_DIR = join(ROOT, '.claude', 'commands');
const WORKFLOWS_DIR = join(ROOT, '.claude', 'workflows');
const BENCH_COST_DOC = join(ROOT, 'docs', 'bench-cost.md');

/** The two prompts that drive a measured round. `dogfood-klonoa.md` and `update-m2c.md` are not in
 *  the duplication pair: they describe different workflows and share no phase structure. They ARE
 *  in the link check below — sharing the LAWS is not sharing a phase structure, and until this was
 *  widened those two carried their own fourth copy of law §1 and linked neither doc. */
const PAIR = ['match-function.md', 'attribute-function.md'];

/** The frontmatter plus the "Target function" preamble — identical by design in every command file,
 *  and the one place sharing text is the point rather than a drift hazard. Measured: the shared run
 *  there is 7 lines, so 10 clears it with room for a line being added. */
const PREAMBLE_LINES = 10;

const commandFiles = () => readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
const read = (f: string) => readFileSync(join(COMMANDS_DIR, f), 'utf8').split('\n');
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
    for (const f of commandFiles()) {
      const text = read(f).join('\n');
      for (const doc of ['docs/bench-cost.md', 'docs/measurement-discipline.md']) {
        expect(text, `${f} does not link ${doc} — the laws and the costs are shared by every round`).toContain(doc);
      }
    }
  });
});

describe('every link in a command file resolves', () => {
  // Both spellings: `](../../docs/x.md)` relative to the file, and `](docs/x.md)` relative to the
  // repo root. The first version of this only saw links beginning with `.`, so a repo-root link
  // that 404s was invisible — latent then, and the kind of thing an author writes by habit.
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

describe('docs/bench-cost.md', () => {
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

  it('dates every figure in the cost table', () => {
    const { missing, rows } = tableRows();
    expect(missing, 'docs/bench-cost.md is gone — the prompts link it and it is the only cost table').toBe(false);
    expect(rows.length, 'no table rows found under "## 1." — the section moved or was renamed').toBeGreaterThan(5);
    const undated = rows.filter((l) => !/\b20\d\d-\d\d-\d\d\b/.test(l) && !l.includes('NOT re-measured'));
    expect(
      undated,
      'a cost with no measured date reads as current forever — add the date, or mark it "NOT re-measured"',
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
    const meta = JSON.parse(readFileSync(join(ROOT, 'apps', 'benchmark', 'results', 'results.json'), 'utf8'));
    const artifactAt = Date.parse(meta.meta.generatedAt);
    expect(Number.isFinite(artifactAt), 'results.json has no parseable meta.generatedAt').toBe(true);

    const stale: string[] = [];
    for (const row of rows) {
      if (row.includes('NOT re-measured')) {
        continue;
      } // an honestly labelled historical figure
      const dates = [...row.matchAll(/\b20\d\d-\d\d-\d\d\b/g)].map((m) => Date.parse(m[0]));
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
      if (e.isFile() && /\.(md|js)$/.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

/** A sentence that puts a wall-clock number on a harness or test command.
 *
 *  The first version named only `bench run` / `bench:merge` / "full bench", and so caught exactly
 *  one of the five cost classes this round actually repaired: `~120 candidates/s`, a ranked run's
 *  `1500-8000 s`, `bench fan`'s `~8 minutes`, `bench gates`' `~10 s` and `npx vitest run`'s `~120 s`
 *  were all invisible to it. Mutation-proven: a line pricing `bench fan` and `bench gates` passed.
 *  The vocabulary is now the commands the prompts actually price. */
const BENCH_COST =
  /(?:pnpm |npx )?(?:bench[: ](?:run|merge|fan|gates|baseline|repro|target|diff|regression|setup|fidelity|smoke|verify|publish|vendor|stale-check|in-flight)|full bench|ranked run|ranked enumeration|vitest|test:matching|test:offline)[^\n]{0,140}?\b(?:~|about )?\d[\d,.]*\s*(?:s|sec|seconds|min|minutes|h|hours|ms)\b/i;

/** The full-bench wall clock specifically — the figure that has now gone stale TWICE (the ledger's
 *  "~5 minutes" and the prompts' "~1800 s"), and the one the round's own remediation immediately
 *  retyped into three prompts. */
const FULL_BENCH_COST =
  /(?:pnpm bench run|pnpm bench:merge|full bench|full `?pnpm bench run`?)[^\n]{0,140}?\b(?:~|about )?\d[\d,.]*\s*(?:s|sec|seconds|min|minutes|h|hours)\b/i;

describe('no undated bench cost under .claude/', () => {
  it('every wall-clock claim about a bench command carries a date or defers to docs/bench-cost.md', () => {
    const undated: string[] = [];
    for (const file of claudeFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!BENCH_COST.test(line)) {
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

  it('no prompt retypes the full-bench wall clock', () => {
    const copies: string[] = [];
    for (const f of commandFiles()) {
      read(f).forEach((line, i) => {
        if (FULL_BENCH_COST.test(line)) {
          copies.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(
      copies,
      'a full-bench wall clock inside a prompt is a copy of a docs/bench-cost.md cell and drifts the ' +
        'day the table is re-measured — say "a full `pnpm bench run` is the expensive one (docs/bench-cost.md §1)" ' +
        'and let the reader follow the link. (The ledger may keep its struck-through historical number; a prompt may not.)',
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
  const rooted = /\$\{REPO\}\/[A-Za-z_.]/;
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.js'))) {
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
