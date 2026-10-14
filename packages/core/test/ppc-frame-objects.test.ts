// PPC FRAME OBJECTS (frontend/ppc.ts `measurePpcFrame`, `inLocalArea`, `emitLaddr`): a function that
// takes a frame address (`addi rD,r1,k`), reaches its frame below a word, or stores a word nothing
// reads back with no call to take it, gets a local area (`compilerBehaviors.linkageLocalArea`);
// every r1 access inside it is memory through an `laddr`, and the shared frame-object audit
// (frontend/frame-objects.ts) proves the objects or refuses. An incoming stack word is a parameter
// (`@sarg<k>`). The shapes are mwcc's own (`corpus/probe-mwcc-frame.c` and the review's probes), and
// the refusals are the ways a frame word that is not a local — an outgoing argument, a save, an
// incoming argument, a by-value copy — would otherwise be declared one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { __testing } from '../src/frontend/ppc';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { PPC_MWCC } from '../src/target';

/** One function of hand-written objdump text: each line gets the next address, and a bare
 *  `bl <sym>` its `R_PPC_REL24`. A branch names its target by line index (`@3`). */
const fn = (sym: string, lines: string[]): string =>
  `0 <${sym}>:\n` +
  lines
    .map((l, i) => {
      const at = (i * 4).toString(16);
      const call = /^bl\s+(\S+)$/.exec(l);
      if (call) {
        return `${at}:\tbl      ${at} <${sym}+0x${at}>\n\t\t\t${at}: R_PPC_REL24\t${call[1]}`;
      }
      return `${at}:\t${l.replace(/@(\d+)/, (_, k) => {
        const t = (Number(k) * 4).toString(16);
        return `${t} <${sym}+0x${t}>`;
      })}`;
    })
    .join('\n') +
  '\n';

const PROTOS: Prototypes = {
  fill: { params: ['s32 *'], returnsVoid: true },
  k: { params: ['void *'], returnsVoid: true },
  g1: { params: ['s32'] },
  tb: { params: ['s32', 'struct B'] },
};
const lift = (sym: string, lines: string[], prototypes: Prototypes = PROTOS) =>
  decompile(sym, fn(sym, lines), PPC_MWCC, { prototypes }).source;

// `int escarr(void){ int a[4]; fill(a); return a[0] + a[3]; }` at mwcc_242_81 -O4,p.
const ESCARR = [
  'stwu    r1,-32(r1)',
  'mflr    r0',
  'stw     r0,36(r1)',
  'addi    r3,r1,8',
  'bl fill',
  'lwz     r3,8(r1)',
  'lwz     r0,20(r1)',
  'add     r3,r3,r0',
  'lwz     r0,36(r1)',
  'mtlr    r0',
  'addi    r1,r1,32',
  'blr',
];

// CharRandomize's shape: an array indexed through a capture re-made at each use, the saves at the
// frame top, a value counted up in a loop.
const INDEXED = [
  'stwu    r1,-64(r1)',
  'mflr    r0',
  'stw     r0,68(r1)',
  'stw     r31,60(r1)',
  'stw     r30,56(r1)',
  'li      r31,0',
  'li      r30,0',
  'slwi    r0,r31,2', // 7: loop
  'addi    r3,r1,8',
  'stwx    r30,r3,r0',
  'addi    r31,r31,1',
  'cmpwi   r31,8',
  'blt+    @7',
  'addi    r3,r1,8',
  'bl fill',
  'lwz     r3,12(r1)',
  'lwz     r31,60(r1)',
  'lwz     r30,56(r1)',
  'lwz     r0,68(r1)',
  'mtlr    r0',
  'addi    r1,r1,64',
  'blr',
];

describe('the local area a frame is partitioned by', () => {
  const corpus = (fixture: string) => readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');
  const PROBE_PROTOS: Prototypes = {
    fill: { params: ['s32 *'], returnsVoid: true },
    g1: { params: ['s32'] },
    h9: { params: 9 },
    h10: { params: 10 },
  };

  test.each([
    // [fixture, function, area]: past the linkage and the widest call's stack words, under the saves
    ['mwcc242-frame.txt', 'leafarr', { from: 8, to: 32 }],
    ['mwcc242-frame.txt', 'callarr', { from: 8, to: 32 }],
    ['mwcc242-frame.txt', 'out9arr', { from: 12, to: 44 }],
    ['mwcc242-frame.txt', 'out10arr', { from: 16, to: 44 }],
    ['mwcc242-frame.txt', 'mixout', { from: 12, to: 28 }],
    ['mwcc233-frame.txt', 'mixout', { from: 12, to: 36 }],
    ['mwcc242mp4-frame.txt', 'spillarr', { from: 8, to: 24 }],
  ] as const)('%s %s', (fixture, sym, area) => {
    expect(__testing.frameOf(sym, corpus(fixture), PPC_MWCC, PROBE_PROTOS)?.area).toEqual(area);
  });

  test('nothing is partitioned where nothing takes a frame address or reaches it below a word', () => {
    expect(__testing.frameOf('in9', corpus('mwcc242-frame.txt'), PPC_MWCC, PROBE_PROTOS)).toBeNull();
  });

  test('the saves bound the area, whichever instruction makes them', () => {
    expect(__testing.frameOf('f', fn('f', INDEXED), PPC_MWCC, PROTOS)?.area).toEqual({ from: 8, to: 56 });
    // `_savegpr_29` below `addi r11,r1,64` saves r29..r31 at 52..64
    const routine = ['stwu    r1,-64(r1)', 'mflr    r0', 'stw     r0,68(r1)', 'addi    r11,r1,64', 'bl _savegpr_29'];
    expect(__testing.frameOf('f', fn('f', [...routine, ...INDEXED.slice(5)]), PPC_MWCC, PROTOS)?.area).toEqual({
      from: 8,
      to: 52,
    });
    // a register written before its store is spilled, not saved
    const spill = ['stwu    r1,-32(r1)', 'li      r31,1', 'stw     r31,20(r1)', 'addi    r3,r1,8', 'blr'];
    expect(__testing.frameOf('f', fn('f', spill), PPC_MWCC, PROTOS)?.area).toEqual({ from: 8, to: 32 });
  });

  test('no partition without the target stating a layout', () => {
    const bare = { ...PPC_MWCC, compilerBehaviors: { ...PPC_MWCC.compilerBehaviors, linkageLocalArea: undefined } };
    expect(__testing.frameOf('f', fn('f', ESCARR), bare, PROTOS)).toBeNull();
    expect(() => decompile('f', fn('f', ESCARR), bare, { prototypes: PROTOS })).toThrow(
      /stack pointer r1 used as data/,
    );
  });
});

describe('a captured local lifts as an object in the local area', () => {
  test('escarr: one array, its address handed to the callee', () => {
    expect(lift('escarr', ESCARR)).toBe(
      's32 escarr(void) {\n    u8 sp8[24];\n    s32 *p0;\n    p0 = (s32 *)sp8;\n    fill((s32 *)sp8);\n' +
        '    return *p0 + p0[3];\n}\n',
    );
  });

  test('an array indexed through a capture, as CharRandomize stores into its list', () => {
    const src = lift('f', INDEXED);
    expect(src).toContain('((s32 *)sp8)[v');
    expect(src).toContain('fill((s32 *)sp8)');
  });

  test('a sub-word access inside the area is memory, not a refusal', () => {
    // `short h[2]; h[0] = x; h[1] = x + 1; k(h); return h[1];`
    const src = lift('subslot', [
      'stwu    r1,-16(r1)',
      'mflr    r0',
      'stw     r0,20(r1)',
      'addi    r0,r3,1',
      'sth     r3,8(r1)',
      'addi    r3,r1,8',
      'sth     r0,10(r1)',
      'bl k',
      'lwz     r0,20(r1)',
      'lha     r3,10(r1)',
      'mtlr    r0',
      'addi    r1,r1,16',
      'blr',
    ]);
    expect(src).toContain('k((void *)sp8)');
    expect(src).toContain('return ((s16 *)sp8)[1];');
  });

  test('a capture moved by a constant is the capture at the sum', () => {
    const src = lift('f', [
      'stwu    r1,-32(r1)',
      'mflr    r0',
      'stw     r0,36(r1)',
      'addi    r3,r1,8',
      'addi    r3,r3,4',
      'bl fill',
      'lwz     r3,12(r1)',
      'lwz     r0,36(r1)',
      'mtlr    r0',
      'addi    r1,r1,32',
      'blr',
    ]);
    expect(src).toMatch(/fill\(\(s32 \*\)\(\(u32\)sp8 \+ 4\)\)|fill\(\(s32 \*\)sp8\)/);
  });
});

describe('what the local area refuses', () => {
  const frame = (body: string[]) => ['stwu    r1,-32(r1)', 'mflr    r0', 'stw     r0,36(r1)', ...body];
  const tail = ['lwz     r0,36(r1)', 'mtlr    r0', 'addi    r1,r1,32', 'blr'];

  test('an address above the area: an incoming stack argument (a va_list takes &entry+8)', () => {
    expect(() => lift('f', frame(['addi    r3,r1,40', 'bl k', ...tail]))).toThrow(
      /the captured address at \[sp,#40\) is above the reserved local area/,
    );
  });

  test('an access across the area edge', () => {
    // the area is [8, 28) under the save of r31 at 28; a word at 26 is half local, half save
    expect(() =>
      lift('f', [
        'stwu    r1,-32(r1)',
        'stw     r31,28(r1)',
        'addi    r3,r1,8',
        'lhz     r0,24(r1)',
        'lwz     r0,26(r1)',
        'lwz     r31,28(r1)',
        'addi    r1,r1,32',
        'blr',
      ]),
    ).toThrow(/reaches across an edge of the local area, r1\+8 up to r1\+28/);
  });

  test("a store of the caller's saved register inside the area", () => {
    // r30 is not saved in the prologue, so its entry value stored to the area later is no save
    expect(() =>
      lift('f', [
        'stwu    r1,-32(r1)',
        'stw     r31,28(r1)',
        'cmpwi   r3,0',
        'beq-    @6',
        'stw     r30,8(r1)',
        'addi    r3,r1,8',
        'lwz     r31,28(r1)', // 6
        'addi    r1,r1,32',
        'blr',
      ]),
    ).toThrow(/stores the caller's r30 inside the local area/);
  });

  test('a capture made at another depth than the frame', () => {
    expect(() =>
      lift('f', ['addi    r3,r1,-8', 'stwu    r1,-32(r1)', 'lwz     r3,24(r1)', 'addi    r1,r1,32', 'blr']),
    ).toThrow(/stack pointer r1 used as data/);
  });

  test('a struct passed by value: mwcc passes the address of a frame copy', () => {
    expect(() => lift('f', frame(['li      r3,1', 'addi    r4,r1,8', 'bl tb', ...tail]))).toThrow(
      /takes its parameter 2 as 'struct B' by value/,
    );
  });

  test('an undeclared call filling seven argument registers may take stack words under the area', () => {
    const regs = [3, 4, 5, 6, 7, 8, 9].map((r) => `li      r${r},${r}`);
    expect(() => lift('f', frame(['addi    r3,r1,8', 'bl fill', ...regs, 'bl unk', ...tail]))).toThrow(
      /nothing declares 'unk'.*whether it takes stack words is unknown/,
    );
  });

  test('a frame address plus a runtime index carried across a join', () => {
    // `p = a + i` on one arm, `p = a + j` on the other, then `*p`: which object the sum indexes is
    // not known at the join
    expect(() =>
      lift('f', [
        'stwu    r1,-32(r1)',
        'mflr    r0',
        'stw     r0,36(r1)',
        'cmpwi   r3,0',
        'addi    r6,r1,8',
        'beq-    @8',
        'add     r6,r6,r4',
        'b       @9',
        'add     r6,r6,r5',
        'lwz     r3,0(r6)', // 9
        'lwz     r0,36(r1)',
        'mtlr    r0',
        'addi    r1,r1,32',
        'blr',
      ]),
    ).toThrow(/address-taken stack local/);
  });

  test('a reload of an area word by `lmw`', () => {
    expect(() =>
      lift('f', [
        'stwu    r1,-48(r1)',
        'stmw    r30,40(r1)',
        'addi    r3,r1,8',
        'lmw     r30,8(r1)',
        'addi    r1,r1,48',
        'blr',
      ]),
    ).toThrow(/reloads r30 out of '8\(r1\)', inside the local area/);
  });
});

describe('a word stored and never read back', () => {
  // fn_1_3994's shape at mwcc_242_81 -O0,p: `sp8 = p->unk0` in a loop, never read
  const dead = (call: string[]) => [
    'stwu    r1,-32(r1)',
    'stw     r31,28(r1)',
    ...call,
    'lwz     r0,0(r3)',
    'stw     r0,8(r1)',
    'lwz     r31,28(r1)',
    'addi    r1,r1,32',
    'blr',
  ];

  test('in a function that makes no call, is a dead local, kept as a store', () => {
    expect(lift('f', dead([]), { f: { params: ['s32 *'], returnsVoid: true } })).toBe(
      'void f(s32 *a0) {\n    u32 sp8;\n    sp8 = *a0;\n}\n',
    );
  });

  test('with a call, may be its stack argument, and still refuses', () => {
    expect(() => lift('f', dead(['mr      r31,r3', 'bl unk', 'mr      r3,r31']))).toThrow(
      /'8\(r1\)' is stored at 0x\w+ and never read back/,
    );
  });
});

describe('an incoming stack argument is a parameter', () => {
  test('a leaf reads its ninth argument at entry r1 + 8 and its tenth at + 12', () => {
    expect(lift('in10', ['lwz     r3,8(r1)', 'lwz     r0,12(r1)', 'subf    r3,r0,r3', 'blr'])).toBe(
      's32 in10(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8, s32 a9) {\n' +
        '    return a8 - a9;\n}\n',
    );
  });

  test('read past a pushed frame, at its entry offset', () => {
    const src = lift('in9', ['stwu    r1,-16(r1)', 'lwz     r3,24(r1)', 'addi    r1,r1,16', 'blr']);
    expect(src).toContain('return a8;');
  });

  test('an assignment to it is the same variable', () => {
    const src = lift('own9', ['lwz     r0,8(r1)', 'add     r0,r0,r3', 'stw     r0,8(r1)', 'lwz     r3,8(r1)', 'blr']);
    expect(src).toContain('a8 + a0');
  });

  test('a sub-word incoming argument, one beside a float, and one beside a declared 64-bit parameter refuse', () => {
    expect(() => lift('h', ['lha     r3,10(r1)', 'blr'])).toThrow(/sub-word stack-frame access \('10\(r1\)'\)/);
    expect(() => lift('h', ['lwz     r3,8(r1)', 'fadds   f1,f1,f1', 'blr'])).toThrow(
      /incoming stack argument 9 is read beside the floating-point argument in f1/,
    );
    expect(() =>
      lift('h', ['lwz     r3,8(r1)', 'blr'], {
        h: { params: ['s32', 's32', 's32', 's32', 's32', 's32', 's32', 's64'] },
      }),
    ).toThrow(/beside a parameter declared 's64'/);
  });
});
