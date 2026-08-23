// The `/vol-slot` lever (l3/volatileval.ts): a stack-homed scalar local is re-declared
// `volatile`. The gate conditions are what these tests pin: only a `frame` local (the machine
// really gave it a slot), only a scalar, never one already carrying a volatility flag, never an
// address-taken one, and never one whose accesses in the tree are not the machine's — and no
// qualifying local means DECLINE, never a duplicate candidate.
//
// The end-to-end tests lift agbcc Thumb and check the emitted declaration, so they also pin the
// producer of the `frame` record: a spill slot is marked with its access counts, a register-only
// local is not marked at all.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { type SFn, type Stmt } from '../src/l3/ast';
import { volatileValueLocals } from '../src/l3/volatileval';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const fn = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void(),
  body,
});

test('a stack-homed scalar local becomes a volatile object', () => {
  const s = fn(
    [
      { name: 'sp0', type: T.u(16), frame: { loads: 0, stores: 1 } },
      { name: 'v0', type: T.s(32) },
    ],
    [{ k: 'assign', name: 'sp0', value: { k: 'var', name: 'v0' } }],
  );
  const out = volatileValueLocals(s);
  expect(out?.locals.find((l) => l.name === 'sp0')?.volatile).toBe(true);
  // the register-homed local is untouched even though it is a scalar too
  expect(out?.locals.find((l) => l.name === 'v0')?.volatile).toBeUndefined();
  // read-only: the input tree is not mutated
  expect(s.locals.find((l) => l.name === 'sp0')?.volatile).toBeUndefined();
});

test('a register-homed scalar never qualifies — the machine gave it no slot to force', () => {
  const s = fn([{ name: 'v0', type: T.s(32) }], [{ k: 'assign', name: 'v0', value: { k: 'const', value: 3 } }]);
  expect(volatileValueLocals(s)).toBeNull();
});

test('an already-volatile frame local declines rather than duplicating the primary', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: { loads: 0, stores: 1 }, volatile: true }],
    [{ k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } }],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('an address-taken frame local is excluded — its home is already forced', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: { loads: 0, stores: 1 } }],
    [
      { k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } },
      { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'sp0' }] } },
    ],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('an address taken deep inside a loop arm still vetoes', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: { loads: 0, stores: 0 } }],
    [
      {
        k: 'dowhile',
        cond: { k: 'const', value: 1 },
        body: [{ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'sp0' }] } }],
      },
    ],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('a non-scalar frame local never qualifies', () => {
  const s = fn(
    [{ name: 'sp0', type: T.ptr(T.u(16)), frame: { loads: 0, stores: 1 } }],
    [{ k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } }],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('a store the tree no longer carries declines — `volatile` may not claim a dropped access', () => {
  const body: Stmt[] = [
    { k: 'assign', name: 'sp0', value: { k: 'const', value: 5 } },
    { k: 'return', value: { k: 'var', name: 'sp0' } },
  ];
  expect(volatileValueLocals(fn([{ name: 'sp0', type: T.u(16), frame: { loads: 1, stores: 2 } }], body))).toBeNull();
  // the same local at the machine's own count qualifies, so it is the MISMATCH that vetoes
  expect(
    volatileValueLocals(fn([{ name: 'sp0', type: T.u(16), frame: { loads: 1, stores: 1 } }], body)),
  ).not.toBeNull();
});

test('one machine load rendered as two reads declines — the same rule, other direction', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: { loads: 1, stores: 1 } }],
    [
      { k: 'assign', name: 'sp0', value: { k: 'const', value: 5 } },
      {
        k: 'return',
        value: {
          k: 'call',
          fn: 'h',
          args: [
            { k: 'var', name: 'sp0' },
            { k: 'var', name: 'sp0' },
          ],
        },
      },
    ],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

// A halfword spilled to the stack across a call — the shape the lever was built for, and the
// same fixture frame-base-copy.test.ts uses for the frame-object split.
const SPILL = `f:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x8
\tldrh\tr2, [r0]
\tmov\tr3, sp
\tstrh\tr2, [r3, #0x4]
\tldr\tr3, [r0, #0x4]
\tbl\tg
\tmov\tr2, sp
\tldrh\tr2, [r2, #0x4]
\tadd\tr0, r2, #0
\tadd\tsp, sp, #0x8
\tpop\t{r4}
\tpop\t{r1}
\tbx\tr1
`;

test('the primary keeps the plain declaration — the slot is a fact, the qualifier is not', () => {
  expect(decompile('f', SPILL, ARMV4T_AGBCC).source).toContain('u16 sp4;');
});

test('/vol-slot is enumerated for the spill, and declares the slot volatile', () => {
  const cands = enumerateCandidates('f', SPILL, ARMV4T_AGBCC);
  const vol = cands.find((c) => c.label.endsWith('/vol-slot'));
  expect(vol).toBeDefined();
  expect(vol!.source).toContain('volatile u16 sp4;');
  // …and only the qualifier moved: the body is the primary's, verbatim
  const plain = cands.find((c) => c.label === vol!.label.replace('/vol-slot', ''))!;
  expect(vol!.source.replace('volatile u16 sp4;', 'u16 sp4;')).toBe(plain.source);
});

test('a function with no frame object enumerates no /vol-slot candidate', () => {
  const NOSLOT = `f:\n\tadd\tr0, r0, #0x1\n\tbx\tlr\n`;
  expect(enumerateCandidates('f', NOSLOT, ARMV4T_AGBCC).some((c) => c.label.includes('/vol-slot'))).toBe(false);
});

// agbcc's own output for `s32 dv(u32 a0) { volatile u16 sp0; sp0 = 5; sp0 = a0 + 1; g(a0);
// return sp0; }` — TWO `strh` to the slot, of which asmlift's dead-store pass keeps one.
const DROPPED_STORE = `dv:
\tpush\t{lr}
\tadd\tsp, sp, #-0x4
\tmov\tr2, sp
\tmov\tr1, #0x5
\tstrh\tr1, [r2]
\tadd\tr1, r0, #0x1
\tstrh\tr1, [r2]
\tbl\tg
\tmov\tr0, sp
\tldrh\tr0, [r0]
\tadd\tsp, sp, #0x4
\tpop\t{r1}
\tbx\tr1
`;

test('a slot whose dead store the readability pass dropped enumerates no /vol-slot candidate', () => {
  const opts = { prototypes: { g: { params: 1 } } };
  // the slot IS recovered, so the decline is the access-set rule and not a missing frame object
  expect(decompile('dv', DROPPED_STORE, ARMV4T_AGBCC, opts).source).toContain('u16 sp0;');
  expect(enumerateCandidates('dv', DROPPED_STORE, ARMV4T_AGBCC, opts).some((c) => c.label.includes('/vol-slot'))).toBe(
    false,
  );
});

// One `ldrh` feeding two uses: the structurer emits one C read per USE, so the tree reads the
// slot twice where the machine loaded it once.
const COLLAPSED_LOAD = `f:
\tpush\t{lr}
\tadd\tsp, sp, #-0x8
\tadd\tr2, r0, #0x1
\tmov\tr3, sp
\tstrh\tr2, [r3, #0x4]
\tbl\tg
\tmov\tr3, sp
\tldrh\tr2, [r3, #0x4]
\tadd\tr0, r2, #0
\tadd\tr1, r2, #0
\tbl\th
\tadd\tsp, sp, #0x8
\tpop\t{r1}
\tbx\tr1
`;

test('a slot read twice from one machine load enumerates no /vol-slot candidate', () => {
  const opts = { prototypes: { g: { params: 1 }, h: { params: 2 } } };
  expect(decompile('f', COLLAPSED_LOAD, ARMV4T_AGBCC, opts).source).toContain('h(sp4, sp4)');
  expect(enumerateCandidates('f', COLLAPSED_LOAD, ARMV4T_AGBCC, opts).some((c) => c.label.includes('/vol-slot'))).toBe(
    false,
  );
});
