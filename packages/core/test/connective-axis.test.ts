// CONNECTIVE: why the `||` spelling is enumerated beside the recovered comparison tree.
// raise/shortcircuit.ts must pick ONE — a folded `logic_or` is not the `icmp` switch-recover.ts
// requires, so whichever it takes disqualifies the other for the rest of the run. The default
// leaves the tree (the more specific recovery); these tests pin the other half — that the
// connective spelling is a DISTINCT source, enumerated only on a function whose fold actually
// reaches the refusal. Toolchain-free.
//
// WHAT THIS AXIS IS NOT. The stacked arm `switch (x) { case 0: case 2: … }` is the structurer's
// job and is now its DEFAULT (switch-recover.ts groups case values that share a body), which is
// why the row this axis was built for scores the same with it off. It is NOT the same object as
// the `||` in general — that holds only for a switch with one case group plus `default:` (agbcc
// 12 instructions each, IDO 64 bytes each), and a second group parts them (agbcc 20 against 16).
// So the axis stays a real second spelling on a recovered multi-group switch, on top of the tree
// switch recovery DECLINES on entirely — `kleod:CountCollectedGems`, `kleod:CheckWorldCompletion`.
import { describe, expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { applyIdiomPatterns } from '../src/pipeline';
import { runPreRecovery } from '../src/raise/pre-recovery';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const P = { f: { returnsVoid: true } };
const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;
const cands = (body: string) => enumerateCandidates('f', wrap(body), ARMV4T_AGBCC, { prototypes: P });
const distinct = (cs: { source: string }[]) => new Set(cs.map((c) => c.source)).size;

// ONE scrutinee against TWO constants, both tests reaching one shared block: the head's fall edge
// carries the second test, and either match takes the shared arm.
const TREE =
  '\tldr\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tcmp\tr0, #2\n\tbne\t.L4\n' +
  '.L2:\n\tmov\tr2, #5\n\tstr\tr2, [r1]\n\tb\t.L5\n' +
  '.L4:\n\tmov\tr2, #9\n\tstr\tr2, [r1]\n.L5:\n';

describe('/connective is enumerated wherever the tree refusal has an inhabitant', () => {
  test('a same-scrutinee const-test chain emits BOTH spellings', () => {
    const all = cands(TREE);
    expect(all.some((c) => c.label.includes('/connective'))).toBe(true);
    // Not a duplicate the dedup would have collapsed — dropping the axis drops a distinct
    // spelling, which is what makes the shape a question for the differ and not for a predicate.
    expect(distinct(all)).toBeGreaterThan(distinct(all.filter((c) => !c.label.includes('/connective'))));
    expect(all.some((c) => c.label.includes('/connective') && / \|\| |&&/.test(c.source))).toBe(true);
  });

  test('…and the tree spelling survives beside it', () => {
    // `pokeemerald:IsStringLengthAtLeast` and `pokeemerald:TrySetCantSelectMoveBattleScript` are
    // the corpus rows this protects: both reach the refusal and both keep their score only because
    // the tree spelling is still in the fan to win it. An axis that REPLACED the default rather
    // than joining it costs them.
    const all = cands(TREE);
    expect(all.some((c) => !c.label.includes('/connective') && !/ \|\| /.test(c.source))).toBe(true);
  });

  // The scrutinee is a POOL-LOADED global, the one input that differs between the two lifts: the
  // map names the word, the `/raw-globals` arm sees a bare address. `constTestScrutinee` reads
  // through whichever the lift produced, so the gate's answer must not depend on which.
  const POOL_TREE =
    '\tldr\tr1, .L9\n\tldr\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tcmp\tr0, #2\n\tbne\t.L4\n' +
    '.L2:\n\tmov\tr2, #5\n\tstr\tr2, [r1]\n\tb\t.L5\n' +
    '.L4:\n\tmov\tr2, #9\n\tstr\tr2, [r1]\n.L5:\n';
  const POOL_ASM = `f:\n\tpush\t{lr}\n${POOL_TREE}\tpop\t{r1}\n\tbx\tr1\n.L9:\n\t.word\t0x3001234\n`;
  const POOL_SYMBOLS: SymbolMap = new Map([[0x3001234, [{ name: 'gMode', kind: 'data' }]]]);

  test('the PREDICATE is asked in both symbol-map configurations, and answers the same', () => {
    // The obligation is on the predicate, so this asks the predicate — not the candidate labels,
    // which a single shared boolean would satisfy just as well and which is what this test used to
    // do. Lift the same function twice, with the map and without, and count the sites each lift's
    // OWN refusal reports. rank.ts now reads one answer per symbol variant for exactly this
    // reason; over every benchmark row that lifts the two agree (21 sites mapped, 21 raw), and the
    // failure mode if a lift-time change ever splits them is a variant never enumerated.
    const sites = (symbols?: SymbolMap): number => {
      const fn = frontendFor(ARMV4T_AGBCC).lift('f', POOL_ASM, ARMV4T_AGBCC, P, undefined, symbols);
      applyIdiomPatterns(fn, ARMV4T_AGBCC, undefined);
      let seen = 0;
      runPreRecovery(fn, ARMV4T_AGBCC, undefined, P.f, { shortCircuit: { onTreeOwned: () => seen++ } });
      return seen;
    };
    expect(sites(POOL_SYMBOLS)).toBeGreaterThan(0);
    expect(sites(undefined)).toBe(sites(POOL_SYMBOLS));
  });

  test('…and each symbol variant enumerates the axis off its own answer', () => {
    const conn = enumerateCandidates('f', POOL_ASM, ARMV4T_AGBCC, { prototypes: P, symbols: POOL_SYMBOLS }).filter(
      (c) => c.label.includes('/connective'),
    );
    expect(conn.some((c) => c.label.includes('/raw-globals'))).toBe(true);
    expect(conn.some((c) => !c.label.includes('/raw-globals'))).toBe(true);
  });

  test('a function whose fold never reaches the refusal pays nothing for it', () => {
    // Two different scrutinees: an ordinary `||` the fold already takes, so there is no second
    // spelling to referee and no variant to enumerate.
    const PLAIN =
      '\tldr\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tldr\tr3, [r1, #4]\n\tcmp\tr3, #2\n\tbne\t.L4\n' +
      '.L2:\n\tmov\tr2, #5\n\tstr\tr2, [r1]\n\tb\t.L5\n' +
      '.L4:\n\tmov\tr2, #9\n\tstr\tr2, [r1]\n.L5:\n';
    expect(cands(PLAIN).some((c) => c.label.includes('/connective'))).toBe(false);
  });
});
