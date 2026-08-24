// THE SIGNEDNESS AXIS and what it costs. The axis itself — pin the entry scalars signed, then
// unsigned, and let the differ referee — is pinned by the rows that win on each side; this file
// pins the other half: where a second pass produces no candidate at all. Toolchain-free.
import { describe, expect, test, vi } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Frontend } from '../src/frontend/frontend';
import type { LanguageBackend } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { type SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** Lifts taken by the enumeration under test. The DECLINE's entire effect is a lift that never
 *  happens, and it is invisible everywhere downstream: a decline that stopped firing would re-lift,
 *  re-raise, re-structure, reach the tree the first pass already emitted, and be dropped by the tree
 *  skip — same candidates, same labels, same print count. So the guard counts lifts. */
const lifts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/frontend/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/frontend/registry')>();
  return {
    ...actual,
    frontendFor: (target: Parameters<typeof actual.frontendFor>[0]): Frontend => {
      const f = actual.frontendFor(target);
      return {
        ...f,
        lift: (...args: Parameters<Frontend['lift']>) => {
          lifts.n++;
          return f.lift(...args);
        },
      };
    },
  };
});

const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;

/** cBackend, plus every spelling it was asked to print — the enumeration's real work, where the
 *  candidate list shows only what survived the dedup. */
function recordingBackend(): { backend: LanguageBackend; emitted: string[] } {
  const emitted: string[] = [];
  return {
    backend: {
      ...cBackend,
      emit: (fn) => {
        const s = cBackend.emit(fn);
        emitted.push(s);
        return s;
      },
    },
    emitted,
  };
}

describe('the signedness axis declines where the pin writes nothing', () => {
  // r0 is dereferenced, so it recovers as a pointer and NO_PIN_KINDS excludes it: `pinScalarParams`
  // has no scalar entry param to write, and both passes would lift the identical function.
  const PTR_ONLY = '\tldr\tr1, [r0]\n\tadd\tr1, r1, #1\n\tstr\tr1, [r0]\n';

  test('a function whose every entry param is a pointer is enumerated ONCE', () => {
    const { backend, emitted } = recordingBackend();
    lifts.n = 0;
    const cands = enumerateCandidates('f', wrap(PTR_ONLY), ARMV4T_AGBCC, { backend });
    // The whole enumeration collapses onto one spelling, so the print count IS the work: eight
    // axis points all reaching ONE structured tree, spelled once — never eight identical strings.
    expect(cands.length).toBe(1);
    expect(new Set(emitted).size).toBe(1);
    expect(emitted.length).toBe(1);
    // …and the declined second pass never even lifted: the probe's lift plus the first pass's.
    expect(lifts.n).toBe(2);
  });

  test('…and a scalar entry param keeps both passes', () => {
    // The counterpart, and what keeps the counts above about the PIN rather than only about the
    // tree skip: here the pin writes, the two passes reach two different trees, and both are
    // spelled. A pin that wrote nothing would collapse this to one tree, one label and one lift.
    const { backend, emitted } = recordingBackend();
    lifts.n = 0;
    const cands = enumerateCandidates('f', wrap('\tasr\tr0, r0, #2\n'), ARMV4T_AGBCC, { backend });
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed']);
    expect(emitted.length).toBe(2);
    expect(lifts.n).toBe(3);
  });

  // The per-variant decline, the shape addr-home.test.ts pins for its own gate: the `/raw-globals`
  // sibling lifts WITHOUT the map, so it decides for itself whether the pin has a param. A decline
  // read from one shared probe would answer for a lift it is not the lift of.
  const SCALAR_AND_GLOBAL =
    'f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tadds\tr0, r0, r1\n\tbx\tlr\n.L1:\n\t.word\t0x8057acc\n';

  test('both symbol variants carry both passes', () => {
    const symbols: SymbolMap = new Map([[0x8057acc, [{ name: 'gCounter', kind: 'data' }]]]);
    const cands = enumerateCandidates('f', SCALAR_AND_GLOBAL, ARMV4T_AGBCC, { symbols });
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed', 'unsigned/raw-globals', 'signed/raw-globals']);
  });
});
