// The `/livebase-block/homesplit` PAIRING (l3/homesplit.ts): one base kept at the function head and
// a SECOND base split per region, in one function — the spelling neither `/livebase-block` nor
// `/regionbase` reaches alone, because each applies its own policy to EVERY base it binds.
//
// It is a PIPE, never a merge: `hoistBaseLocals` runs first with one key WITHHELD, and
// `hoistScopedBases` then sees that key's accesses still inline (every homed key's accesses now
// read through a LOCAL, which `shadowed-or-nonarray-base` refuses). That ordering is what makes the
// two passes' minted names disjoint without anything having to reconcile them — `nameAllocator`
// re-derives its taken names from the tree it is handed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { LIVEBASE_BLOCK_GATES, admittedBases } from '../src/l3/basecse';
import { HOMESPLIT_GATES, splitHomeBases, withholdingKey } from '../src/l3/homesplit';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const IWRAM = 0x03004000;
const DEVICE = 0x040000d4;

const at = (base: number, idx: number): Expr => ({
  k: 'index',
  base: { k: 'const', value: base },
  idx: { k: 'const', value: idx },
  width: 4,
  signed: true,
});
/** `DEVICE[d] = IWRAM[s];` — one store through each base, the dmapoll body's unit. */
const move = (d: number, s: number): Stmt => ({ k: 'store', lval: at(DEVICE, d), value: at(IWRAM, s) });
const set = (d: number, v: number): Stmt => ({ k: 'store', lval: at(DEVICE, d), value: { k: 'const', value: v } });

const fn = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals: [],
  globals: [],
  retType: T.void(),
  body,
});

/** dmapoll's shape, IR-side: three disjoint regions each moving two cells and writing a control
 *  word, through ONE device base and ONE IWRAM base. */
const TWO_BASES = fn([
  {
    k: 'if',
    cond: at(IWRAM, 0),
    then: [move(0, 1), move(1, 2), set(2, 0x20)],
    else: [move(0, 2), move(1, 3), set(2, 0x40)],
  },
  move(0, 4),
  move(1, 5),
  set(2, 0x80),
]);

const OPTS = { gates: LIVEBASE_BLOCK_GATES, placement: 'head' as const, hoistableKeys: 2 };
const DMA_KEY = `c:${DEVICE} 4 true`;
const IWRAM_KEY = `c:${IWRAM} 4 true`;

/** every `name = (T *)<addr>;` the tree assigns, as `name→addr` */
const homes = (s: SFn): Record<string, number> => {
  const out: Record<string, number> = {};
  const walk = (list: Stmt[]): void => {
    for (const st of list) {
      if (st.k === 'assign' && st.value.k === 'cast' && st.value.e.k === 'const') {
        out[st.name] = st.value.e.value;
      }
      if (st.k === 'if') {
        walk(st.then);
        walk(st.else);
      }
    }
  };
  walk(s.body);
  return out;
};

describe('the withhold is DATA — one rejection in the existing gate type', () => {
  test('both bases are admitted by `/livebase-block`, and withholding one removes exactly it', () => {
    expect(admittedBases(TWO_BASES, LIVEBASE_BLOCK_GATES)).toEqual([IWRAM_KEY, DMA_KEY]);
    expect(admittedBases(TWO_BASES, withholdingKey(LIVEBASE_BLOCK_GATES, DMA_KEY))).toEqual([IWRAM_KEY]);
    expect(admittedBases(TWO_BASES, withholdingKey(LIVEBASE_BLOCK_GATES, IWRAM_KEY))).toEqual([DMA_KEY]);
  });

  test('…and it is a heuristic in the table, so `firstRejection` can name it', () => {
    expect(withholdingKey(LIVEBASE_BLOCK_GATES, DMA_KEY)[0].id).toBe('withheld-key');
    expect(withholdingKey(LIVEBASE_BLOCK_GATES, DMA_KEY)[0].sound).toBe(false);
  });
});

describe('the pipe reaches the shape neither lever reaches alone', () => {
  test('the withheld base becomes N REGION locals; the other keeps its head home', () => {
    const p = splitHomeBases(TWO_BASES, { ...OPTS, key: DMA_KEY })!;
    expect(p).not.toBeNull();
    const h = homes(p.split);
    const addrs = Object.values(h);
    expect(addrs.filter((a) => a === IWRAM)).toHaveLength(1);
    expect(addrs.filter((a) => a === DEVICE)).toHaveLength(3);
    // …and the ONE head home is the first statement of the body, above the `if`
    expect(p.split.body[0]).toMatchObject({ k: 'assign', value: { e: { value: IWRAM } } });
  });

  test('the two passes mint DISJOINT names — the pipe re-derives its taken names', () => {
    const p = splitHomeBases(TWO_BASES, { ...OPTS, key: DMA_KEY })!;
    const names = p.split.locals.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(4);
  });

  test('withholding the OTHER key is a different spelling, not the same one relabelled', () => {
    const p = splitHomeBases(TWO_BASES, { ...OPTS, key: IWRAM_KEY })!;
    const addrs = Object.values(homes(p.split));
    expect(addrs.filter((a) => a === DEVICE)).toHaveLength(1);
    expect(addrs.filter((a) => a === IWRAM)).toHaveLength(3);
  });
});

describe('the refusals, each priced by the spelling it keeps out of the fan', () => {
  test('homesplit-degenerate: withholding the only hoistable key is `/regionbase` under a second name', () => {
    expect(splitHomeBases(TWO_BASES, { ...OPTS, key: DMA_KEY, hoistableKeys: 1 })).toBeNull();
  });

  test('homesplit-fan-cap: more than three hoistable keys is a fan the pairing does not buy', () => {
    expect(splitHomeBases(TWO_BASES, { ...OPTS, key: DMA_KEY, hoistableKeys: 4 })).toBeNull();
  });

  test('homesplit-no-region: a withheld key the region rule will not split buys nothing', () => {
    // Both bases used only inside ONE arm: `regions-degenerate` refuses the region reading, so the
    // residue is the un-hoisted spelling the primary already carries.
    const oneRegion = fn([
      { k: 'if', cond: { k: 'const', value: 1 }, then: [move(0, 1), move(1, 2), set(2, 0x20)], else: [] },
    ]);
    expect(admittedBases(oneRegion, LIVEBASE_BLOCK_GATES)).toHaveLength(2);
    expect(splitHomeBases(oneRegion, { ...OPTS, key: DMA_KEY })).toBeNull();
  });

  test('homesplit-drops-device-volatile: a device READ left inline is qualified by neither product', () => {
    // `/volatile` reaches only MINTED POINTER LOCALS and `/vol-store` only a STORE at a fixed device
    // address, so a device read the region rule leaves inline carries no qualifier at all — and
    // withholding the key is what leaves it there. PR #123 records a lever WINNING a row by
    // dropping a device `volatile` the spelling it replaced carried.
    const withARead = fn([
      {
        k: 'if',
        cond: at(IWRAM, 0),
        then: [move(0, 1), move(1, 2), set(2, 0x20)],
        else: [move(0, 2), move(1, 3), set(2, 0x40)],
      },
      { k: 'store', lval: at(IWRAM, 6), value: at(DEVICE, 7) },
    ]);
    expect(splitHomeBases(withARead, { ...OPTS, key: DMA_KEY, deviceRegisters: [0x04000000, 0x04000400] })).toBeNull();
    // with no device window declared the target makes no such claim, and the pairing rides
    expect(splitHomeBases(withARead, { ...OPTS, key: DMA_KEY })).not.toBeNull();
  });

  test('the table is the complete list, and nothing in it claims to be sound', () => {
    expect(HOMESPLIT_GATES.map((g) => g.id)).toEqual([
      'homesplit-degenerate',
      'homesplit-fan-cap',
      'homesplit-no-region',
      'homesplit-drops-device-volatile',
    ]);
    expect(HOMESPLIT_GATES.every((g) => !g.sound)).toBe(true);
  });
});

describe('the pairing is OFFERED, and additively', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmapoll.s'), 'utf8');
  const cands = enumerateCandidates('dmapoll', asm, ARMV4T_AGBCC, {
    prototypes: { dmapoll: { params: ['s32'], returnsVoid: true } },
  });

  test('`/livebase-block/homesplit` is in the fan', () => {
    expect(cands.filter((c) => c.label.includes('/livebase-block/homesplit')).length).toBeGreaterThan(0);
  });

  test('…and every spelling it composes from is STILL in the fan', () => {
    // Hard Rule 3: the pairing sits BESIDE its two halves and the un-hoisted primary, and the
    // differ settles the allocation. A pairing that replaced either half could cost `dmaflat`.
    expect(cands.some((c) => /\/livebase-block(\/volatile)?$/.test(c.label))).toBe(true);
    expect(cands.some((c) => c.label.includes('/regionbase'))).toBe(true);
  });

  test('BOTH withholds are enumerated — which key the source homed is not derivable', () => {
    // The endpoint cell is ONE local at 0x03004000 and THREE at 0x040000D4; its mirror is the same
    // spelling with the two bases exchanged. Nothing in the asm says which the source wrote, so
    // both ride and the differ settles it — the posture `/scopebase` and `/regionbase` already take.
    const count = (src: string, addr: number): number =>
      new Set([...src.matchAll(new RegExp(`(\\w+) = \\((?:volatile )?s32 \\*\\)${addr};`, 'g'))].map((m) => m[1])).size;
    const shapes = cands
      .filter((c) => c.label.includes('/livebase-block/homesplit'))
      .map((c) => `${count(c.source, 0x03004000)}:${count(c.source, 0x040000d4)}`);
    expect(shapes).toContain('1:3');
    expect(shapes).toContain('3:1');
  });
});
