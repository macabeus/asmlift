// DETERMINISM + CROSS-FUNCTION INDEPENDENCE of the whole decompile path — aimed at structure(),
// whose ~20 per-invocation mutable maps/counters (varName, tempCounter, fresh, activeSub, …) are
// the state a refactor could accidentally hoist to module scope. determinism.test.ts only covers
// ir/parse+print; nothing else runs the SAME function twice in one process, or after OTHER
// functions, and asserts byte-identical output. Here: every input is decompiled three times —
// forward pass, reverse-order pass (different predecessors = contamination shows), and a repeat
// pass — and all three must agree byte-for-byte per input.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const read = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

// One entry per ISA family plus the stateful shapes: a loop (countdown — naming + coalescing), a
// swap-cycle back edge (tempCounter), sequential loops (nested withSub merge), and a pool-global
// base-CSE hoist (frontend + L3 state). Each `run` builds everything from scratch — any output
// difference across passes is leaked module state or genuine nondeterminism, never the fixture.
const INPUTS: Array<{ id: string; run: () => string }> = [
  { id: 'thumb:clamp0', run: () => decompile('clamp0', read('agbcc-clamp0.s'), ARMV4T_AGBCC).source },
  { id: 'ido:countdown', run: () => decompile('countdown', read('ido-countdown.asm'), MIPS_IDO).source },
  { id: 'gcc:aget', run: () => decompile('aget', read('gcc-aget.asm'), MIPS_GCC).source },
  { id: 'ppc:shl3', run: () => decompile('shl3', read('ppc-shl3.asm'), PPC_MWCC).source },
  {
    id: 'thumb:basecse',
    run: () =>
      decompile(
        'initcfg',
        'initcfg:\n\tldr\tr2, .L1\n\tmov\tr0, #0x1\n\tstrb\tr0, [r2]\n\tmov\tr0, #0x2\n' +
          '\tstrb\tr0, [r2, #0x1]\n\tbx\tlr\n.L1:\n\t.word\tgCfg\n',
        ARMV4T_AGBCC,
      ).source,
  },
];

test('decompile is deterministic and independent of what ran before it', () => {
  const forward = INPUTS.map((i) => ({ id: i.id, src: i.run() }));
  const reversed = [...INPUTS].reverse().map((i) => ({ id: i.id, src: i.run() }));
  const repeat = INPUTS.map((i) => ({ id: i.id, src: i.run() }));

  const by = (rows: { id: string; src: string }[]) => new Map(rows.map((r) => [r.id, r.src]));
  const rev = by(reversed);
  const rep = by(repeat);
  for (const { id, src } of forward) {
    expect(src, `${id}: reverse-order run diverged — module-scoped state?`).toBe(rev.get(id));
    expect(src, `${id}: repeat run diverged — per-call nondeterminism?`).toBe(rep.get(id));
    expect(src.length, `${id}: produced empty output`).toBeGreaterThan(0);
  }
});
