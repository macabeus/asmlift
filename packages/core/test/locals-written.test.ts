// UNIT tests for the structuring boundary contract (contracts.ts assertLocalsWritten): a local the
// emitted body reads must be assigned somewhere in it.
//
// Hand-built AST, the way resolved-contract.ts pins its rule — the coverage is the point,
// independent of which pass can produce the shape today. A materialized value renders as ONE
// `v = …` statement at its def's position; drop that position and the reads stand over whatever
// the register allocator left, in C that compiles and scores.
//
// Two locals are legitimately unwritten and both declare it: `uninit` (the local stands on an
// `undef` — the missing assignment IS the recovery) and `frame` (the machine's own slot, whose
// store the readability passes may drop).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { ContractError, assertLocalsWritten } from '../src/contracts';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const READ: Stmt = { k: 'return', value: { k: 'var', name: 'v0' } };
const fnWith = (local: SFn['locals'][number], body: Stmt[] = [READ]): SFn => ({
  name: 'f',
  params: [],
  locals: [local],
  retType: T.int(32, true),
  body,
});
const plain = { name: 'v0', type: T.int(32, true) } as const;

test('a local written before its read passes — the control the refusals are measured against', () => {
  expect(() =>
    assertLocalsWritten(fnWith(plain, [{ k: 'assign', name: 'v0', value: { k: 'const', value: 1 } }, READ])),
  ).not.toThrow();
});

test('a local read and assigned NOWHERE is refused', () => {
  expect(() => assertLocalsWritten(fnWith(plain))).toThrow(ContractError);
});

test('the write may sit anywhere — presence, not reaching definitions', () => {
  // One arm assigns and the other does not: unassigned on a path is the shape `uninit` locals are
  // for, and asking the path question here would refuse every one of them a second time.
  const armed: Stmt = {
    k: 'if',
    cond: { k: 'const', value: 1 },
    then: [{ k: 'assign', name: 'v0', value: { k: 'const', value: 1 } }],
    else: [],
  };
  expect(() => assertLocalsWritten(fnWith(plain, [armed, READ]))).not.toThrow();
});

test('`&v` counts as a write — the callee behind it may fill the object', () => {
  const escape: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'v0' }] } };
  expect(() => assertLocalsWritten(fnWith(plain, [escape, READ]))).not.toThrow();
});

test('an `uninit` local reads unwritten by construction, and a `frame` local may', () => {
  expect(() => assertLocalsWritten(fnWith({ ...plain, uninit: true }))).not.toThrow();
  expect(() => assertLocalsWritten(fnWith({ ...plain, frame: { loads: 1, stores: 0 } }))).not.toThrow();
});

// …AND IT RUNS ON LEVER TREES. `structureChecked` runs all four boundary contracts on the tree it
// produces (pipeline.ts); `rank.ts`'s `respell` then re-runs the ones a LEVER can break on every
// re-spelling, because a lever that loses an assignment produces exactly what this contract names —
// C that compiles, scores, and can WIN, which is the one wrongness the byte differ rewards rather
// than catches (#106 shipped it). The population that can produce it is the placement passes:
// l3/sinkinit.ts, l3/basecse.ts's first-use policy, l3/nearbase.ts, l3/scopebase.ts, l3/argbase.ts.
describe('the LEVER guard set', () => {
  const rankSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'rank.ts'), 'utf8');
  const times = (name: string) => rankSrc.split(`${name}(`).length - 1;

  test('is applied as a SET — every lever spelling gets all three, or none of them does', () => {
    // The defect this pins is a NEW guard site added with two of the three, which is what the
    // shipped version of this round had: `assertLocalsWritten` was in `structureChecked` and in
    // neither of `respell`'s two emit paths. Counting rather than pattern-matching a call site, so
    // the rule survives reformatting and states the invariant instead of a line number.
    expect(times('assertResolved')).toBeGreaterThan(0);
    expect(times('assertDerefsTyped')).toEqual(times('assertResolved'));
    expect(times('assertLocalsWritten')).toEqual(times('assertResolved'));
  });

  test('and no lever in the offline corpus violates it — the invariant behind the guard', () => {
    // The guard is only useful if it is not already firing, and the corpus is where a placement
    // lever would show. `emit` is the choke point every spelling passes through, so wrapping the
    // backend sees every tree the fan asks to render, products included.
    const seen: SFn[] = [];
    const probing = { ...cBackend, emit: (t: SFn) => (seen.push(t), cBackend.emit(t)) };
    const dir = join(import.meta.dirname, 'corpus');
    const agbcc = readdirSync(dir).filter((f) => f.startsWith('agbcc-') && f.endsWith('.s'));
    expect(agbcc.length).toBeGreaterThan(5);
    for (const f of agbcc) {
      const sym = f.replace(/^agbcc-|\.s$/g, '');
      try {
        enumerateCandidates(sym, readFileSync(join(dir, f), 'utf8'), ARMV4T_AGBCC, {
          prototypes: { [sym]: { returnsVoid: true } },
          backend: probing,
        });
      } catch {
        continue; // a fixture whose symbol this file does not name — not this test's business
      }
    }
    expect(seen.length).toBeGreaterThan(100);
    expect(seen.filter((t) => !passes(t))).toEqual([]);
  });
});

const passes = (t: SFn): boolean => {
  try {
    assertLocalsWritten(t);
    return true;
  } catch {
    return false;
  }
};
