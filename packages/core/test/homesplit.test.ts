// The `/livebase-block/homesplit` PAIRING (l3/homesplit.ts): one base kept at the function head and
// a SECOND base split per region, in one function — the spelling neither `/livebase-block` nor
// `/regionbase` reaches alone, because each applies its own policy to EVERY base it binds.
//
// It is a PIPE, never a merge: `hoistBaseLocals` runs first with one key WITHHELD, and
// `hoistScopedBases` then sees that key's accesses still inline (every homed key's accesses now
// read through a LOCAL, which `shadowed-or-nonarray-base` refuses). That ordering is what makes the
// two passes' minted names disjoint without anything having to reconcile them — `nameAllocator`
// re-derives its taken names from the tree it is handed.
//
// The admission is TWO tables at two cadences: `HOMESPLIT_FAN_GATES` reads the tree's key count and
// is asked once (`homeSplitWithholds`), `HOMESPLIT_GATES` reads one withheld key's own pipe.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { LIVEBASE_BLOCK_GATES, admittedBases, hoistBaseLocals } from '../src/l3/basecse';
import { without } from '../src/l3/gates';
import {
  HOMESPLIT_FAN_GATES,
  HOMESPLIT_GATES,
  homeSplitTag,
  homeSplitWithholds,
  splitHomeBases,
  withholdingKey,
} from '../src/l3/homesplit';
import { volatilePtrLocals } from '../src/l3/volatileptr';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const IWRAM = 0x03004000;
const DEVICE = 0x040000d4;
const WINDOW: readonly [number, number] = [0x04000000, 0x04000400];

const idx = (base: Expr, i: number): Expr => ({
  k: 'index',
  base,
  idx: { k: 'const', value: i },
  width: 4,
  signed: true,
});
const at = (base: number, i: number): Expr => idx({ k: 'const', value: base }, i);
/** `DEVICE[d] = IWRAM[s];` — one store through each base, the dmapoll body's unit. */
const move = (d: number, s: number): Stmt => ({ k: 'store', lval: at(DEVICE, d), value: at(IWRAM, s) });
const set = (d: number, v: number): Stmt => ({ k: 'store', lval: at(DEVICE, d), value: { k: 'const', value: v } });

const fn = (body: Stmt[], locals: { name: string; type: ReturnType<typeof T.s> }[] = []): SFn => ({
  name: 'f',
  params: [],
  locals,
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

const OPTS = { gates: LIVEBASE_BLOCK_GATES, placement: 'head' as const };
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

describe('the FUNCTION-level refusals, asked once over the key census', () => {
  test('homesplit-degenerate: withholding the only hoistable key is `/regionbase` under a second name', () => {
    expect(homeSplitWithholds([DMA_KEY])).toEqual([]);
  });

  test('homesplit-fan-cap: more than three hoistable keys is a fan the pairing does not buy', () => {
    expect(homeSplitWithholds(['a', 'b', 'c'])).toHaveLength(3);
    expect(homeSplitWithholds(['a', 'b', 'c', 'd'])).toEqual([]);
  });

  test('…and they are the WHOLE function-level table, so nothing else is decided per key', () => {
    expect(HOMESPLIT_FAN_GATES.map((g) => g.id)).toEqual(['homesplit-degenerate', 'homesplit-fan-cap']);
    expect(HOMESPLIT_FAN_GATES.every((g) => !g.sound)).toBe(true);
  });
});

describe('the PER-KEY refusals, each priced by the spelling it keeps out of the fan', () => {
  test('homesplit-no-region: a withheld key the region rule will not split buys nothing', () => {
    // Both bases used only inside ONE arm: `regions-degenerate` refuses the region reading, so the
    // residue is the un-hoisted spelling the primary already carries.
    const oneRegion = fn([
      { k: 'if', cond: { k: 'const', value: 1 }, then: [move(0, 1), move(1, 2), set(2, 0x20)], else: [] },
    ]);
    expect(admittedBases(oneRegion, LIVEBASE_BLOCK_GATES)).toHaveLength(2);
    expect(splitHomeBases(oneRegion, { ...OPTS, key: DMA_KEY })).toBeNull();
    // …and ABLATING it is a pure removal, not a throw. The applier's loud `declined` throw rests on
    // exactly what this rule establishes, so without the rule that guarantee is gone — and a throw
    // there would price the rule at every dropped candidate rather than at the spelling it refuses.
    const ablated = { ...OPTS, key: DMA_KEY, admission: without(HOMESPLIT_GATES, 'homesplit-no-region') };
    expect(() => splitHomeBases(oneRegion, ablated)).not.toThrow();
    expect(splitHomeBases(oneRegion, ablated)).toBeNull();
  });

  /** the dmapoll shape plus ONE device read the region rule leaves inline, at `where` */
  const withInlineRead = (where: 'stmt' | 'for-init' | 'for-inc'): SFn => {
    const arms: Stmt = {
      k: 'if',
      cond: at(IWRAM, 0),
      then: [move(0, 1), move(1, 2), set(2, 0x20)],
      else: [move(0, 2), move(1, 3), set(2, 0x40)],
    };
    const read = at(DEVICE, 7);
    const zero: Expr = { k: 'const', value: 0 };
    if (where === 'stmt') {
      return fn([arms, { k: 'store', lval: at(IWRAM, 6), value: read }]);
    }
    const init: Stmt = { k: 'assign', name: 'i', value: where === 'for-init' ? read : zero };
    const inc: Stmt = { k: 'assign', name: 'i', value: where === 'for-inc' ? read : zero };
    return fn([arms, { k: 'for', init, cond: { k: 'var', name: 'i' }, inc, body: [] }], [{ name: 'i', type: T.s(32) }]);
  };

  test('homesplit-drops-device-volatile: a device READ left inline is qualified by neither product', () => {
    // `/volatile` reaches only MINTED POINTER LOCALS and `/vol-store` only a STORE at a fixed device
    // address, so a device read the region rule leaves inline carries no qualifier at all — and
    // withholding the key is what leaves it there.
    expect(splitHomeBases(withInlineRead('stmt'), { ...OPTS, key: DMA_KEY, deviceRegisters: WINDOW })).toBeNull();
    // with no device window declared the target makes no such claim, and the pairing rides
    expect(splitHomeBases(withInlineRead('stmt'), { ...OPTS, key: DMA_KEY })).not.toBeNull();
  });

  test('…including one in a `for`s INIT or INC, which no expression walk of the loop reaches', () => {
    // `stmtExprs` of a `for` is its condition and `stmtLists` its body: a read in either statement
    // part is reached by neither, so a walk that stops there admits the very spelling this refuses.
    for (const where of ['for-init', 'for-inc'] as const) {
      expect(splitHomeBases(withInlineRead(where), { ...OPTS, key: DMA_KEY, deviceRegisters: WINDOW })).toBeNull();
    }
  });

  test('…and it asks `/volatile` about the home it replaces, so a NAMED device base RIDES', () => {
    // Under a symbol map an absolute pool constant lifts to a `gaddr`, and `/volatile` VETOES a
    // local fed `&gSym` — the symbol map owns a declared global's volatility. So on a named base
    // the head home this rule protects is unqualified too, nothing is dropped, and refusing there
    // would delete a spelling to protect a qualifier NEITHER side carries. Asserted through
    // `volatilePtrLocals` itself, so the rule and the qualifier cannot drift apart in silence.
    const shape = (dev: Expr, iw: Expr): SFn =>
      fn([
        {
          k: 'if',
          cond: idx(iw, 0),
          then: [
            { k: 'store', lval: idx(dev, 0), value: idx(iw, 1) },
            { k: 'store', lval: idx(dev, 1), value: idx(iw, 2) },
          ],
          else: [
            { k: 'store', lval: idx(dev, 0), value: idx(iw, 2) },
            { k: 'store', lval: idx(dev, 1), value: idx(iw, 3) },
          ],
        },
        { k: 'store', lval: idx(iw, 6), value: idx(dev, 7) },
      ]);
    const sfn = shape({ k: 'addr', name: 'REG_DMA3SAD' }, { k: 'addr', name: 'gBuf' });
    const key = 'a:REG_DMA3SAD 4 true';
    expect(admittedBases(sfn, LIVEBASE_BLOCK_GATES)).toContain(key);
    expect(volatilePtrLocals(hoistBaseLocals(sfn, LIVEBASE_BLOCK_GATES, 'head')!)).toBeNull();
    expect(splitHomeBases(sfn, { ...OPTS, key, deviceRegisters: WINDOW })).not.toBeNull();
    // …and the NUMERIC twin of that same shape, where the baseline IS qualified, refuses — with the
    // refusal attributed by ablating the one rule, so it is not some other gate answering.
    const raw = shape({ k: 'const', value: DEVICE }, { k: 'const', value: IWRAM });
    expect(volatilePtrLocals(hoistBaseLocals(raw, LIVEBASE_BLOCK_GATES, 'head')!)).not.toBeNull();
    expect(splitHomeBases(raw, { ...OPTS, key: DMA_KEY, deviceRegisters: WINDOW })).toBeNull();
    const ablated = without(HOMESPLIT_GATES, 'homesplit-drops-device-volatile');
    expect(splitHomeBases(raw, { ...OPTS, key: DMA_KEY, deviceRegisters: WINDOW, admission: ablated })).not.toBeNull();
  });

  test('the table is the complete list, and nothing in it claims to be sound', () => {
    expect(HOMESPLIT_GATES.map((g) => g.id)).toEqual(['homesplit-no-region', 'homesplit-drops-device-volatile']);
    expect(HOMESPLIT_GATES.every((g) => !g.sound)).toBe(true);
  });
});

describe('the label names the withheld key, because a label is an identity', () => {
  test('the tag spells the base and the access shape', () => {
    expect(homeSplitTag(DMA_KEY)).toBe('0x40000d4.4s');
    expect(homeSplitTag(IWRAM_KEY)).toBe('0x3004000.4s');
    expect(homeSplitTag('a:REG_DMA3SAD 4 false')).toBe('REG_DMA3SAD.4u');
    // …and a CAST base, whose id carries the element type and therefore a space. Split from the
    // front this read `gEnigmaBerries.<struct Elem5 *>u` — the type as the width, the width as the
    // signedness. Unreachable today (no shipped table admits a cast base except `/orderbase`, which
    // carries `pairings: false`) and pinned anyway, because a label is a candidate's identity.
    expect(homeSplitTag('a:gEnigmaBerries <struct Elem5 *> 28 false')).toBe('gEnigmaBerries<structElem5*>.28u');
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

  test('…and each of them under its OWN label — no label carries two programs', () => {
    // `bench diff` and docs/ranked-repro.md compare candidates BY LABEL, and the fan dedups by
    // SOURCE, so one label over two withholds publishes a winning label that also names a
    // non-match. Asserted over the WHOLE fan, not just this axis: it is a property of the list.
    const bySource = new Map<string, Set<string>>();
    for (const c of cands) {
      bySource.set(c.label, (bySource.get(c.label) ?? new Set()).add(c.source));
    }
    expect([...bySource].filter(([, s]) => s.size > 1).map(([l]) => l)).toEqual([]);
  });
});
