// The command files under `.claude/commands/` are a SPECIFICATION agents follow literally, and
// nothing mechanical has ever looked at them. Three defects this suite makes impossible, each with
// an incident behind it:
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
//   3. A LINK THAT DOES NOT RESOLVE. The prompts delegate half their content to `docs/`; a link
//      that 404s sends the agent back to inference.
//
// It cannot check that an instruction is TRUE — only a command run can. What it holds is the shape
// that lets one file be the place a correction lands.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const COMMANDS_DIR = join(ROOT, '.claude', 'commands');

/** The two prompts that drive a measured round. `dogfood-klonoa.md` and `update-m2c.md` are not in
 *  the duplication pair: they describe different workflows and share no phase structure. */
const PAIR = ['match-function.md', 'attribute-function.md'];

/** The frontmatter plus the "Target function" preamble — identical by design in every command file,
 *  and the one place sharing text is the point rather than a drift hazard. Measured: the shared run
 *  there is 7 lines, so 10 clears it with room for a line being added. */
const PREAMBLE_LINES = 10;

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
      while (i + k < a.length && j + k < b.length && norm(a[i + k]) === norm(b[j + k])) k++;
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

  it('both prompts link the two shared docs', () => {
    for (const f of PAIR) {
      const text = read(f).join('\n');
      for (const doc of ['docs/bench-cost.md', 'docs/measurement-discipline.md']) {
        expect(text, `${f} does not link ${doc}`).toContain(doc);
      }
    }
  });
});

describe('every relative link in a command file resolves', () => {
  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
  const LINK = /\]\((\.[^)#\s]+)(?:#[^)\s]*)?\)/g;
  for (const f of files) {
    it(f, () => {
      const broken: string[] = [];
      readFileSync(join(COMMANDS_DIR, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(LINK)) {
            const target = resolve(dirname(join(COMMANDS_DIR, f)), m[1]);
            if (!existsSync(target)) broken.push(`${f}:${i + 1} → ${m[1]}`);
          }
        });
      expect(broken, `dead link(s): ${broken.join(', ')}`).toEqual([]);
    });
  }
});

describe('docs/bench-cost.md', () => {
  const lines = readFileSync(join(ROOT, 'docs', 'bench-cost.md'), 'utf8').split('\n');

  it('dates every figure in the cost table', () => {
    const start = lines.findIndex((l) => /^##\s+1\./.test(l));
    expect(start, 'the cost table section moved or was renamed').toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    const rows = lines
      .slice(start, end === -1 ? lines.length : end)
      .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !/\|\s*command\s*\|/i.test(l));
    expect(rows.length, 'no table rows found under "## 1."').toBeGreaterThan(5);
    const undated = rows.filter((l) => !/\b20\d\d-\d\d-\d\d\b/.test(l) && !l.includes('NOT re-measured'));
    expect(
      undated,
      'a cost with no measured date reads as current forever — add the date, or mark it "NOT re-measured"',
    ).toEqual([]);
  });
});

/** Everything under `.claude/` an agent or a brief author reads: the two round prompts, the other
 *  two commands, the workflow brief generator and its ledger. */
function claudeFiles(dir = join(ROOT, '.claude'), out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) claudeFiles(p, out);
    else if (/\.(md|js)$/.test(p)) out.push(p);
  }
  return out;
}

/** A sentence that puts a wall-clock number on a bench command. Deliberately narrow: it is the
 *  class that has actually gone stale here — the ledger asserted "a full `pnpm bench run` is ~5
 *  minutes" for months against a run that takes ~34, and both prompts carried "~1800 s — synthetic
 *  182 s + real 1618 s" against 161 + 1,880. */
const BENCH_COST =
  /(?:bench run|bench:merge|full bench|bench\b[^\n]{0,40}\brun\b)[^\n]{0,120}?\b(?:~|about )?\d[\d,.]*\s*(?:s|sec|seconds|min|minutes|h|hours)\b/i;

describe('no undated bench cost under .claude/', () => {
  it('every wall-clock claim about a bench command carries a date or defers to docs/bench-cost.md', () => {
    const undated: string[] = [];
    for (const file of claudeFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!BENCH_COST.test(line)) return;
        // The date may sit on the line or in the sentence around it; so may the deferral.
        const context = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        if (/\b20\d\d-\d\d-\d\d\b/.test(context) || context.includes('docs/bench-cost.md')) return;
        undated.push(`${file.slice(ROOT.length + 1)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    expect(
      undated,
      'a bench cost with no measured date beside it reads as current forever — date it, or point at docs/bench-cost.md',
    ).toEqual([]);
  });
});
