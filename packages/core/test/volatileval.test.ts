// The `/vol-slot` lever (l3/volatileval.ts): a stack-homed scalar local is re-declared
// `volatile`. The gate conditions are what these tests pin: only a `frame` local (the machine
// really gave it a slot), only a scalar, never one already carrying a volatility flag, never an
// address-taken one — and no qualifying local means DECLINE, never a duplicate candidate.
//
// The end-to-end tests lift agbcc Thumb and check the emitted declaration, so they also pin the
// producer of the `frame` flag: a spill slot is marked, a register-only local is not.
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
      { name: 'sp0', type: T.u(16), frame: true },
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
    [{ name: 'sp0', type: T.u(16), frame: true, volatile: true }],
    [{ k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } }],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('an address-taken frame local is excluded — its home is already forced', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: true }],
    [
      { k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } },
      { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'sp0' }] } },
    ],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('an address taken deep inside a loop arm still vetoes', () => {
  const s = fn(
    [{ name: 'sp0', type: T.u(16), frame: true }],
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
    [{ name: 'sp0', type: T.ptr(T.u(16)), frame: true }],
    [{ k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } }],
  );
  expect(volatileValueLocals(s)).toBeNull();
});

test('`only` narrows the lever to the named locals', () => {
  const s = fn(
    [
      { name: 'sp0', type: T.u(16), frame: true },
      { name: 'sp4', type: T.s(32), frame: true },
    ],
    [
      { k: 'assign', name: 'sp0', value: { k: 'const', value: 0 } },
      { k: 'assign', name: 'sp4', value: { k: 'const', value: 0 } },
    ],
  );
  const out = volatileValueLocals(s, new Set(['sp4']));
  expect(out?.locals.map((l) => [l.name, l.volatile])).toEqual([
    ['sp0', undefined],
    ['sp4', true],
  ]);
  expect(volatileValueLocals(s, new Set(['nobody']))).toBeNull();
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
