// THE SIGNEDNESS AXIS and what it costs. The axis itself — pin the entry scalars signed, then
// unsigned, and let the differ referee — is pinned by the rows that win on each side; this file
// pins the other half: where a second pass produces no candidate at all. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { LanguageBackend } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

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
    const cands = enumerateCandidates('f', wrap(PTR_ONLY), ARMV4T_AGBCC, { backend });
    // The whole enumeration collapses onto one spelling, so the print count IS the work: eight
    // axis points, printed once each. With the second pin pass running it was sixteen — the same
    // eight strings a second time, every one of them thrown away by the dedup.
    expect(cands.length).toBe(1);
    expect(new Set(emitted).size).toBe(1);
    expect(emitted.length).toBe(8);
  });

  test('…and a scalar entry param keeps both passes', () => {
    const cands = enumerateCandidates('f', wrap('\tasr\tr0, r0, #2\n'), ARMV4T_AGBCC, {});
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed']);
  });
});
