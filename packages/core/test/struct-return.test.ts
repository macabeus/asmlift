// A call to a function declared to return a struct or union BY VALUE. agbcc hands such a callee a
// hidden pointer in r0 and moves every declared argument one register up (thumb.h:644-645, 672), so a
// lift that reads the declared parameters from r0 names the pointer as the first argument. Every
// fixture not marked hand-written is agbcc's own output at the corpus flags (`-mthumb-interwork -O2
// -fhex-asm -fprologue-bugfix`), or mwcc_242_81's at the synthetic tier's.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { decompile } from '../src/pipeline';
import { declaresAggregateReturn, symbolPrototype } from '../src/proto';
import { withOwnReturnLayout } from '../src/proto-context';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

// `struct Blob64 { u32 w[16]; }; struct Blob64 makeblob(const void *); extern struct Blob64 gDst;
//  void p4(void){ gDst = makeblob(gBlob); }` — a global destination is handed over directly
// (calls.c:1001-1009), so there is no frame for the frame-object audit to see.
const P4 =
  'p4:\n\tpush\t{lr}\n\tldr\tr0, .L3\n\tldr\tr1, .L3+0x4\n\tbl\tmakeblob\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgDst\n\t.word\tgBlob\n';

// `void p1(void){ struct Blob64 b = makeblob(gBlob); }` — the storage is a frame temp (the
// synthetic row `stkextsret`)
const P1 =
  'p1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x40\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tbl\tmakeblob\n' +
  '\tadd\tsp, sp, #0x40\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgBlob\n';
// `struct S4 { u8 a, b, c, d; }; u32 q1(s32 x){ struct S4 s = mk4(x); return s.a; }`
const Q1 =
  'q1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk4\n' +
  '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
// `struct S4 …; void u3(s32 x, s32 y){ mk4(x); mk4(y); }` — two temps, one per call
// `struct S4 { u16 a; u8 b; u8 pad; }; struct S4 mk(u16, u16, u8); void sret4two(u16 x){ struct S4 s;
//  s = mk(x, 0, 0x10); if (s.a != 0xFFFF) { gOut = s.a; gOut2 = s.b; } s = mk(x + 4, 0, 0x10); …same… }`
//  — two temps, at [sp,#0] and [sp,#4], each read back whole (the synthetic row `sret4two`)
const SRET4TWO =
  'sret4two:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n' +
  '\tadd\tr4, r0, #0\n\tmov\tr0, sp\n\tadd\tr1, r4, #0\n\tmov\tr2, #0x0\n\tmov\tr3, #0x10\n\tbl\tmk\n' +
  '\tldr\tr2, [sp]\n\tlsl\tr0, r2, #0x10\n\tlsr\tr0, r0, #0x10\n\tldr\tr5, .L5\n\tcmp\tr0, r5\n\tbeq\t.L3\n' +
  '\tldr\tr0, .L5+0x4\n\tstrh\tr2, [r0]\n\tldr\tr1, .L5+0x8\n\tlsr\tr0, r2, #0x10\n\tlsl\tr0, r0, #0x18\n' +
  '\tlsr\tr0, r0, #0x18\n\tstrh\tr0, [r1]\n.L3:\n\tadd\tr1, r4, #0x4\n\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n' +
  '\tadd\tr0, sp, #0x4\n\tmov\tr2, #0x0\n\tmov\tr3, #0x10\n\tbl\tmk\n\tldr\tr2, [sp, #0x4]\n\tlsl\tr0, r2, #0x10\n' +
  '\tlsr\tr0, r0, #0x10\n\tcmp\tr0, r5\n\tbeq\t.L4\n\tldr\tr0, .L5+0x4\n\tstrh\tr2, [r0]\n\tldr\tr1, .L5+0x8\n' +
  '\tlsr\tr0, r2, #0x10\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tstrh\tr0, [r1]\n.L4:\n\tadd\tsp, sp, #0x8\n' +
  '\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L6:\n\t.align\t2, 0\n.L5:\n\t.word\t0xffff\n\t.word\tgOut\n\t.word\tgOut2\n';
// hand-written: [sp,#0] handed to `fill`, then staged as `five`'s fifth argument
const FILL_THEN_FIVE =
  'c2:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tmov\tr0, sp\n\tbl\tfill\n' +
  '\tldr\tr1, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr4, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n' +
  '\tmov\tr3, #0x4\n\tbl\tfive\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
const U3 =
  'u3:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r0, #0\n\tadd\tr4, r1, #0\n\tmov\tr0, sp\n' +
  '\tadd\tr1, r2, #0\n\tbl\tmk4\n\tadd\tr0, sp, #0x4\n\tadd\tr1, r4, #0\n\tbl\tmk4\n\tadd\tsp, sp, #0x8\n' +
  '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

// `struct B8 { u32 a, b; }; void s6(u32 x){ struct B8 r; u32 a[3]; a[0] = x; r = mk8(x); gV = a[0]; }`
// — `a[1]` and `a[2]` are frame words nothing reads or writes
const S6 =
  's6:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x14\n\tadd\tr1, r0, #0\n\tstr\tr1, [sp]\n\tadd\tr0, sp, #0xc\n' +
  '\tbl\tmk8\n\tldr\tr1, .L3\n\tldr\tr0, [sp]\n\tstr\tr0, [r1]\n\tadd\tsp, sp, #0x14\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgV\n';

// `u32 u3(u32 a, u32 b, u32 c, u32 d){ u32 x, e, f, g, h, i, j; struct B8 r; e = gF(a); f = gF(b);
//  g = gF(c); h = gF(d); i = gF(e); j = gF(f); if (a) x = gF(h); r = mk8(b); g4(e, f, g, h);
//  g4(i, j, x, a); return x; }` — `r`'s temp is [sp,#0..8) and `x` spills to [sp,#8], unstored when
//  `a` is 0
const U3_UNDEF =
  'u3:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, sl\n\tmov\tr6, r9\n\tmov\tr5, r8\n' +
  '\tpush\t{r5, r6, r7}\n\tadd\tsp, sp, #-0x10\n\tadd\tr6, r0, #0\n\tmov\tsl, r1\n' +
  '\tadd\tr4, r2, #0\n\tadd\tr5, r3, #0\n\tbl\tgF\n\tmov\tr8, r0\n\tmov\tr0, sl\n\tbl\tgF\n' +
  '\tadd\tr7, r0, #0\n\tadd\tr0, r4, #0\n\tbl\tgF\n\tstr\tr0, [sp, #0xc]\n\tadd\tr0, r5, #0\n' +
  '\tbl\tgF\n\tadd\tr4, r0, #0\n\tmov\tr0, r8\n\tbl\tgF\n\tmov\tr9, r0\n\tadd\tr0, r7, #0\n' +
  '\tbl\tgF\n\tadd\tr5, r0, #0\n\tcmp\tr6, #0\n\tbeq\t.L3\n\tadd\tr0, r4, #0\n\tbl\tgF\n' +
  '\tstr\tr0, [sp, #0x8]\n.L3:\n\tmov\tr0, sp\n\tmov\tr1, sl\n\tbl\tmk8\n\tmov\tr0, r8\n' +
  '\tadd\tr1, r7, #0\n\tldr\tr2, [sp, #0xc]\n\tadd\tr3, r4, #0\n\tbl\tg4\n\tmov\tr0, r9\n' +
  '\tadd\tr1, r5, #0\n\tldr\tr2, [sp, #0x8]\n\tadd\tr3, r6, #0\n\tbl\tg4\n' +
  '\tldr\tr0, [sp, #0x8]\n\tadd\tsp, sp, #0x10\n\tpop\t{r3, r4, r5}\n\tmov\tr8, r3\n' +
  '\tmov\tr9, r4\n\tmov\tsl, r5\n\tpop\t{r4, r5, r6, r7}\n\tpop\t{r1}\n\tbx\tr1\n';

// `struct Blob64 mkd(double); void ps1(void){ struct Blob64 b = mkd(1.5); }` — the double is r1:r2,
// high word first, one register up from where it would be without the hidden pointer
const PS1 =
  'ps1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x40\n\tldr\tr2, .L3+0x4\n\tldr\tr1, .L3\n\tmov\tr0, sp\n' +
  '\tbl\tmkd\n\tadd\tsp, sp, #0x40\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.long 0x3ff80000, 0x0\n';

// `struct Blob64 mkp(double *p, double x); void ps2(double *q){ struct Blob64 b = mkp(q, 1.5); }` —
// the pointer in r1, the double r2:r3
const PS2 =
  'ps2:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x40\n\tadd\tr1, r0, #0\n\tldr\tr3, .L3+0x4\n\tldr\tr2, .L3\n' +
  '\tmov\tr0, sp\n\tbl\tmkp\n\tadd\tsp, sp, #0x40\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n' +
  '\t.long 0x3ff80000, 0x0\n';

// `extern double gD; struct Blob64 mk3(s32 a, s32 b, double x); void si(s32 a, s32 b){ struct Blob64 t
// = mk3(a, b, gD); }` — the double, loaded word by word, is r3 and [sp,#0]
const SI =
  'si:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x44\n\tadd\tr5, r0, #0\n\tadd\tr2, r1, #0\n\tldr\tr0, .L3\n' +
  '\tldr\tr3, [r0]\n\tldr\tr4, [r0, #0x4]\n\tstr\tr4, [sp]\n\tadd\tr0, sp, #0x4\n\tadd\tr1, r5, #0\n\tbl\tmk3\n' +
  '\tadd\tsp, sp, #0x44\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgD\n';

const BLOB64 = { kind: 'struct' as const, members: [{ name: 'w', type: 'u32', dims: [16] }] };
const S4 = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })) };
const makeblob = { params: ['const void *'], returns: 'struct Blob64', returnLayout: BLOB64 };
const mk4 = { params: ['s32'], returns: 'struct S4', returnLayout: S4 };
const S4AB = {
  kind: 'struct' as const,
  members: [
    { name: 'a', type: 'u16' },
    { name: 'b', type: 'u8' },
    { name: 'pad', type: 'u8' },
  ],
};
const mkab = { params: ['u16', 'u16', 'u8'], returns: 'struct S4', returnLayout: S4AB };
const mk8 = {
  params: ['u32'],
  returns: 'struct B8',
  returnLayout: { kind: 'struct' as const, members: ['a', 'b'].map((name) => ({ name, type: 'u32' })) },
};

describe('a callee declared to return a struct through memory', () => {
  test('its storage is a local of the declared type, and the call fills it', () => {
    const { source } = decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob } });
    expect(source).toContain('struct Blob64 sp0;');
    expect(source).toContain('sp0 = makeblob(&gBlob);');
  });

  // `typedef struct { u32 w[16]; } Blob64;` names no tag: the local is declared by the typedef name
  // the header spells it with
  test('a typedef name is the spelling the local is declared with', () => {
    const named = { ...makeblob, returns: 'Blob64' };
    const { source } = decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: named } });
    expect(source).toContain('    Blob64 sp0;');
    expect(source).toContain('sp0 = makeblob(&gBlob);');
  });

  // The struct is the headers' type: the source this lift prints never defines it — a project
  // compiling it inside its headers would see it twice — and the declarations block does, which a
  // candidate compiled inside those headers drops
  test('its definition is in the declarations block, not in the source', () => {
    for (const [returns, lines] of [
      ['struct Blob64', ['struct Blob64 { u32 w[16]; };', 'struct Blob64 makeblob(const void *);']],
      ['BlobT', ['struct BlobT { u32 w[16]; };', 'typedef struct BlobT BlobT;', 'BlobT makeblob(const void *);']],
    ] as const) {
      const [c] = enumerateCandidates('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: { ...makeblob, returns } } });
      expect(c.source).not.toMatch(/^struct /m);
      const decls = renderDeclarations(c.symbolRefs ?? []);
      for (const line of lines) {
        expect(decls).toContain(line);
      }
    }
  });

  // The frontend lays a declared `double` out, so the printed prototype carries it, and with it the
  // struct the call returns: without either the candidate's own unit cannot compile the lift.
  test('a callee that takes a double is declared with it', () => {
    const mkd = { params: ['double'], returns: 'struct Blob64', returnLayout: BLOB64 };
    const [c] = enumerateCandidates('ps1', PS1, ARMV4T_AGBCC, { prototypes: { mkd } });
    expect(c.source).toContain('sp0 = mkd(1.5);');
    const decls = renderDeclarations(c.symbolRefs ?? []);
    expect(decls).toContain('struct Blob64 { u32 w[16]; };');
    expect(decls).toContain('struct Blob64 mkd(double);');
  });

  // A double nothing here can hand the callee declines, and names the argument as the source counts
  // it: the hidden pointer is no argument of the C call
  test('a declared double it cannot hand on is named by its place in the C call', () => {
    const mk3 = { params: ['s32', 's32', 'double'], returns: 'struct Blob64', returnLayout: BLOB64 };
    expect(() => decompile('si', SI, ARMV4T_AGBCC, { prototypes: { mk3 } })).toThrow(
      "argument 3 of the call to 'mk3' is a `double` its callee declares",
    );
  });

  // A parameter the frontend sizes but the printer cannot spell leaves the struct's local with no
  // definition in the candidate's own unit, so the call declines rather than lift to a source that
  // cannot compile
  test('a callee the lifted source cannot declare declines', () => {
    for (const params of [['double *', 'double'], ['size_t', 'double'], ['double *']]) {
      const mkp = { params, returns: 'struct Blob64', returnLayout: BLOB64 };
      expect(() => decompile('ps2', PS2, ARMV4T_AGBCC, { prototypes: { mkp } })).toThrow(
        /`mkp` returns struct Blob64 through a hidden pointer in r0, and a parameter type of its declaration has no spelling/,
      );
    }
  });

  // a bare count sizes every argument and states no type the printer could declare the callee with
  test('a callee declared by a parameter count declines, and the message says so', () => {
    expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: { ...makeblob, params: 1 } } })).toThrow(
      /`makeblob` returns struct Blob64 through a hidden pointer in r0, and its declaration states only a count of parameters, no type the lifted source can declare it with/,
    );
  });

  // `struct Blob64 mke(enum E e);` — an enum parameter sizes to nothing, and a guessed arity would
  // read the hidden pointer in r0 as the first argument
  test('with parameters nothing sizes, it declines', () => {
    const mke = { ...makeblob, params: ['enum E'] };
    expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: mke } })).toThrow(
      /returns struct Blob64 through a hidden pointer in r0, and its parameters are not all sized/,
    );
    expect(() =>
      decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: { ...makeblob, params: undefined } } }),
    ).toThrow(/its parameters are not all sized/);
  });

  // a struct with a second member goes through memory whether or not anything sizes it, and one
  // nothing sizes has no type to declare the local by; nor has a union, whose IR type has no name
  test('a union, or a struct this target does not size, declines', () => {
    const union = { ...makeblob, returns: 'union U', returnLayout: { ...BLOB64, kind: 'union' as const } };
    const unsized = {
      ...makeblob,
      returnLayout: {
        kind: 'struct' as const,
        members: [
          { name: 'a', type: 'u8' },
          { name: 'w', type: 'Opaque' },
        ],
      },
    };
    for (const p of [union, unsized]) {
      expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: p } })).toThrow(
        /the local it lands in has no type here/,
      );
    }
  });

  // a 64-byte struct of members the IR mostly cannot type: it is the local all the same, and the
  // declarations block defines it from the declaration
  test('a struct with members the IR cannot type is still the local, defined from its declaration', () => {
    const returnLayout = {
      kind: 'struct' as const,
      members: [
        { name: 'i', type: { kind: 'struct' as const, members: ['a', 'b'].map((name) => ({ name, type: 'u8' })) } },
        { name: 'lo', type: 'u32', bits: 4 },
        { name: '', type: 'u32', bits: 3 },
        { name: 'name', type: 'char', dims: [8] },
        { name: 'k', type: 'enum Kind' },
        { name: 'p', type: 'const struct In *' },
        { name: 'n', type: 'int8_t' },
        { name: 'pad', type: 'u8', dims: [39] },
      ],
    };
    const [c] = enumerateCandidates('p1', P1, ARMV4T_AGBCC, {
      prototypes: { makeblob: { ...makeblob, returnLayout } },
    });
    expect(c.source).toContain('struct Blob64 sp0;');
    expect(renderDeclarations(c.symbolRefs ?? [])).toContain(
      'struct Blob64 { struct { u8 a; u8 b; } i; u32 lo : 4; u32 : 3; char name[8]; ' +
        'enum { asmlift_Blob64_enum0 } k; void *p; s8 n; u8 pad[39]; };',
    );
  });

  test('every argument reads one register up, and each call fills its own local', () => {
    const { source } = decompile('u3', U3, ARMV4T_AGBCC, { prototypes: { mk4 } });
    expect(source).toContain('sp0 = mk4(a0);');
    expect(source).toContain('sp4 = mk4(a1);');
  });

  // no call takes a stack word, so [sp,#0] is the first temp's, not an outgoing argument; each
  // member is read where the source used it, the word load being agbcc's CSE of those reads
  test('a temp at the frame base of a wider frame is an object', () => {
    const { source } = decompile('sret4two', SRET4TWO, ARMV4T_AGBCC, { prototypes: { mk: mkab } });
    expect(source).toContain('    struct S4 sp0;\n    struct S4 sp4;\n    sp0 = mk(a0, 0, 16);');
    expect(source).toMatch(/if \(sp0\.a != v0\) \{\n {8}gOut = sp0\.a;\n {8}gOut2 = sp0\.b;\n {4}\}/);
    expect(source).toMatch(/if \(sp4\.a != v0\) \{\n {8}gOut = sp4\.a;\n {8}gOut2 = sp4\.b;\n {4}\}/);
  });

  test('a frame base staged as a fifth argument is not an object', () => {
    const prototypes = {
      fill: { params: ['u32 *'], returnsVoid: true as const },
      five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true as const },
    };
    expect(() => decompile('c2', FILL_THEN_FIVE, ARMV4T_AGBCC, { prototypes })).toThrow(
      /\[sp,#0\] escapes this function, so the words from there up are an object's/,
    );
  });

  test('a read of the returned struct reads its member', () => {
    expect(decompile('q1', Q1, ARMV4T_AGBCC, { prototypes: { mk4 } }).source).toContain(
      '    sp0 = mk4(a0);\n    return sp0.a;',
    );
  });

  // `mov r0, sp / bl mk4` then one use of the word read back: the low byte, the top byte, a middle
  // byte, two bytes that are no one member, the word whole
  test('each use of the word names the member whose bits it keeps, or the word stays one read', () => {
    const q = (use: string) =>
      decompile(
        'q',
        Q1.replace('q1:', 'q:').replace('\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n', use),
        ARMV4T_AGBCC,
        {
          prototypes: { mk4 },
        },
      ).source;
    expect(q('\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n')).toContain('return sp0.a;');
    expect(q('\tlsr\tr0, r0, #0x18\n')).toContain('return sp0.d;');
    expect(q('\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x18\n')).toContain('return sp0.b;');
    expect(q('\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n')).toContain('return (u16)*(s32 *)&sp0;');
    expect(q('')).toContain('return *(s32 *)&sp0;');
  });

  // the word read before a second call fills the same temp, its member used in a later block: read
  // where the word was, since the call between rewrites it; with no call between, read at the use
  test('a member is read at its use only where nothing rewrites the struct in between', () => {
    const twice =
      'q:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr5, r1, #0\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n' +
      '\tbl\tmk4\n\tldr\tr4, [sp]\n\tmov\tr0, sp\n\tmov\tr1, #0x1\n\tbl\tmk4\n\tmov\tr0, #0x0\n\tcmp\tr5, #0x0\n' +
      '\tbeq\t.L2\n\tlsl\tr0, r4, #0x18\n\tlsr\tr0, r0, #0x18\n.L2:\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5}\n\tpop\t{r1}\n' +
      '\tbx\tr1\n';
    expect(decompile('q', twice, ARMV4T_AGBCC, { prototypes: { mk4 } }).source).toContain(
      '    v0 = sp0.a;\n    sp0 = mk4(1);\n    if (a1 == 0) v0 = 0;',
    );
    const once = twice.replace('\tmov\tr0, sp\n\tmov\tr1, #0x1\n\tbl\tmk4\n', '');
    expect(decompile('q', once, ARMV4T_AGBCC, { prototypes: { mk4 } }).source).toContain(
      '    if (a1 != 0) {\n        v0 = sp0.a;\n',
    );
  });

  test('a write into the returned struct declines', () => {
    const w = Q1.replace('\tldr\tr0, [sp]\n', '\tmov\tr1, #0x5\n\tmov\tr0, sp\n\tstrb\tr1, [r0]\n\tldr\tr0, [sp]\n');
    expect(() => decompile('q1', w, ARMV4T_AGBCC, { prototypes: { mk4 } })).toThrow(
      /the object at \[sp,#0\) is where `mk4` returns struct S4, and this function also writes it/,
    );
  });

  test('a read past the returned struct declines', () => {
    const past =
      'q:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk4\n\tmov\tr1, sp\n' +
      '\tldr\tr0, [r1, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('q', past, ARMV4T_AGBCC, { prototypes: { mk4 } })).toThrow(
      /returns struct S4, and this function reads \[sp,#4\) of width 4, past the struct/,
    );
  });

  test('a struct returned straight into a global declines', () => {
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob } })).toThrow(
      /`makeblob` returns struct Blob64 through the pointer in r0, and that pointer is not the address of a local/,
    );
  });

  // the call writes the eight bytes of its struct and nothing else, so the words it never reaches
  // are not frame it writes past
  test('a frame word outside the returned struct is one the call does not reach', () => {
    const { source } = decompile('s6', S6, ARMV4T_AGBCC, { prototypes: { mk8 } });
    expect(source).toContain('struct B8 sp12;');
    expect(source).toContain('sp12 = mk8(a0);');
    expect(source).toContain('gV = a0;');
  });

  // …and the slot beside it has no writer but this function, so where no store reaches it the
  // value is still uninitialised
  test('an unstored slot outside the returned struct is one the call does not write', () => {
    const { source } = decompile('u3', U3_UNDEF, ARMV4T_AGBCC, { prototypes: { mk8 } });
    expect(source).toContain('struct B8 sp0;');
    expect(source).toContain('if (a0 != 0) v6 = gF(v3);');
    expect(source).toContain('sp0 = mk8(a1);');
    expect(source).toContain('g4(v4, v5, v6, a0);');
  });

  test('without a declared return it is the frame the out-parameter refusal names', () => {
    expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: { params: 1 } } })).toThrow(
      /`makeblob` takes it at argument 0 and nothing says what that callee returns/,
    );
  });
});

describe('a callee declared to return a struct or union by value', () => {
  // `struct One mv(); void other(); void f(s32 a, s32 b) { other(mv(a), b); }` — agbcc passes the
  // struct `mv` hands back in r0 straight on as `other`'s argument 0, with `b` in r1
  test('a struct returned in r0 and passed on to a guessed call declines', () => {
    const F =
      'f:\n\tpush\t{r4, lr}\n\tadd\tr4, r1, #0\n\tbl\tmv\n\tadd\tr1, r4, #0\n\tbl\tother\n' +
      '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const layout = { kind: 'struct' as const, members: [{ name: 'a', type: 's32' }] };
    expect(() =>
      decompile('f', F, ARMV4T_AGBCC, {
        prototypes: { mv: { params: ['s32'], returns: 'struct One', returnLayout: layout } },
      }),
    ).toThrow(/argument 1 of the call to 'other' is a struct an earlier call handed back in r0/);
    // …and where `mv`'s own parameters are unstated its guess refuses first: `b` read into r4 and
    // `a` left in r0 is a gap (frontend/ssa.ts `fallbackArgc`)
    expect(() =>
      decompile('f', F, ARMV4T_AGBCC, { prototypes: { mv: { returns: 'struct One', returnLayout: layout } } }),
    ).toThrow(/the call 'bl mv' in block 'f' has no prototype, r1 holds a value and r0 holds none/);
  });

  // `struct One { s32 a; }; struct One mv(s32 x, ...); s32 cv(s32 a) { return mv(a).a; }` — agbcc
  // hands the one-word struct back in r0, and nothing sizes the variadic call's arguments
  test("a struct returned in r0 is not a value r0 holds when the call's arity is guessed", () => {
    const CV = 'cv:\n\tpush\t{lr}\n\tbl\tmv\n\tpop\t{r1}\n\tbx\tr1\n';
    const mv = {
      returns: 'struct One',
      returnLayout: { kind: 'struct' as const, members: [{ name: 'a', type: 's32' }] },
    };
    expect(() => decompile('cv', CV, ARMV4T_AGBCC, { prototypes: { mv } })).toThrow(
      /r0 is read on a path where a call has destroyed it/,
    );
  });

  test('a Thumb call to one declines where nothing says it comes back through memory', () => {
    const makeblob = { params: ['const void *'], returns: 'struct Blob64' };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob } })).toThrow(
      /`makeblob` is declared to return struct Blob64 by value, and nothing here says whether it comes back.*`returnLayout`/,
    );
    // a typedef name states it through `returnLayout`
    const typedefd = { params: ['const void *'], returns: 'Blob', returnLayout: { kind: 'struct' as const } };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob: typedefd } })).toThrow(
      /`makeblob` is declared to return Blob by value/,
    );
    // told only an arity, nothing separates the pointer from an argument, and `gBlob` is dropped
    expect(decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob: { params: 1 } } }).source).toContain(
      'makeblob(&gDst);',
    );
  });

  // a POINTER to a struct is a register return, whatever keyword it is spelled with — the shape
  // of ac-decomp's `struct message_window_s * mMsg_Get_base_window_p(void)`
  test('a pointer to a struct is not one', () => {
    const g = { params: [], returns: 'struct message_window_s *' };
    expect(declaresAggregateReturn(g)).toBe(false);
    expect(declaresAggregateReturn({ returns: 'const struct S' })).toBe(true);
    const ppc =
      '0 <c>:\n0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\n' +
      'c:\tbl      c <c+0xc>\n\t\t\tc: R_PPC_REL24\tg\n' +
      '10:\tlwz     r0,20(r1)\n14:\tmtlr    r0\n18:\taddi    r1,r1,16\n1c:\tblr\n';
    expect(decompile('c', ppc, PPC_MWCC, { prototypes: { g } }).source).toContain('return g();');
    const thumb = 'c:\n\tpush\t{lr}\n\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('c', thumb, ARMV4T_AGBCC, { prototypes: { g } }).source).toContain('return g();');
  });

  // DWARF sizes a return and states no kind; a signless non-pointer one wider than a word is an
  // aggregate, whatever the parameters say
  test('a symbol map whose signature returns a struct states one', () => {
    const blob = { size: 64, signed: null };
    const symbols = (params: { size: number | null; signed: boolean | null; pointer?: boolean }[]) =>
      new Map([[0x1000, [{ name: 'makeblob', kind: 'code' as const, signature: { returns: blob, params } }]]]);
    for (const params of [[{ size: 4, signed: null, pointer: true }], [{ size: 12, signed: null }]]) {
      expect(() => decompile('p4', P4, ARMV4T_AGBCC, { symbols: symbols(params) })).toThrow(
        /`makeblob` is declared to return a struct or union by value, and nothing here says whether it comes back/,
      );
    }
    // a word-wide signless return is an enum as often as a struct, and states nothing
    const word = new Map([
      [0x1000, [{ name: 'mke', kind: 'code' as const, signature: { returns: { size: 4, signed: null }, params: [] } }]],
    ]);
    expect(symbolPrototype(word.get(0x1000)![0])).toEqual({ params: [] });
  });

  // `struct W1 { u32 x; }; void q2(s32 i){ mkw(i); usei(i + 1); }` — agbcc hands a one-member
  // word back in r0 (thumb.c:1423-1493), so there is no hidden pointer and no argument moves
  test('one that comes back in the return register takes its arguments where they are declared', () => {
    const mkw = {
      params: ['s32'],
      returns: 'struct W1',
      returnLayout: { kind: 'struct' as const, members: [{ name: 'x', type: 'u32' }] },
    };
    const q2 =
      'q2:\n\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tbl\tmkw\n\tadd\tr4, r4, #0x1\n\tadd\tr0, r4, #0\n' +
      '\tbl\tusei\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('q2', q2, ARMV4T_AGBCC, { prototypes: { mkw } }).source).toContain('mkw(a0);');
    // r0 is the struct's bytes, which nothing reads as a struct (hand-written: r0 returned as-is)
    const q3 = 'q3:\n\tpush\t{lr}\n\tbl\tmkw\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('q3', q3, ARMV4T_AGBCC, { prototypes: { mkw } })).toThrow(
      /r0 is read on a path where a call has destroyed it/,
    );
    // mwcc hands back up to 8 bytes in r3/r3:r4 — `typedef struct { u8 r, g, b, a; } GXColor;`
    const getcol = {
      params: ['s32'],
      returns: 'GXColor',
      returnLayout: { kind: 'struct' as const, members: ['r', 'g', 'b', 'a'].map((name) => ({ name, type: 'u8' })) },
    };
    const f =
      '00000000 <f>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,20(r1)\n   c:\tstw     r31,12(r1)\n' +
      '  10:\tmr      r31,r3\n  14:\tbl      14 <f+0x14>\n\t\t\t14: R_PPC_REL24\tgetcol\n  18:\taddi    r3,r31,1\n' +
      '  1c:\tbl      1c <f+0x1c>\n\t\t\t1c: R_PPC_REL24\tusei\n  20:\tlwz     r0,20(r1)\n  24:\tlwz     r31,12(r1)\n' +
      '  28:\tmtlr    r0\n  2c:\taddi    r1,r1,16\n  30:\tblr\n';
    const usei = { params: ['s32'], returnsVoid: true as const };
    expect(decompile('f', f, PPC_MWCC, { prototypes: { getcol, usei } }).source).toContain('getcol(a0);');
    // …and r3 past it is the struct's bytes (hand-written: the call's result read as a word)
    const u = f.replace('<f>', '<u>').replace('addi    r3,r31,1', 'addi    r3,r3,1');
    expect(() => decompile('u', u, PPC_MWCC, { prototypes: { getcol, usei } })).toThrow(
      /r3 is read on a path where a call has destroyed it/,
    );
  });

  // `struct F1 { f32 x; }`, `struct E1 { Kind k; }` and `struct BF { u32 a:8; u32 b:8; }` each come
  // back in r0 (the same q2 as `mkw`'s, compiled), and mwcc's `typedef struct { f32 x, y; } Vec2;`
  // in r3:r4 (the same `f` as `getcol`'s)
  test('a float, an enum or a bitfield member is sized by the target', () => {
    const q2 =
      'q2:\n\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tbl\tmkw\n\tadd\tr4, r4, #0x1\n\tadd\tr0, r4, #0\n' +
      '\tbl\tusei\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const usei = { params: ['s32'], returnsVoid: true as const };
    for (const members of [
      [{ name: 'x', type: 'float' }],
      [{ name: 'k', type: 'enum Kind' }],
      [
        { name: 'a', type: 'u32', bits: 8 },
        { name: 'b', type: 'u32', bits: 8 },
      ],
    ]) {
      const mkw = { params: ['s32'], returns: 'struct W1', returnLayout: { kind: 'struct' as const, members } };
      expect(decompile('q2', q2, ARMV4T_AGBCC, { prototypes: { mkw, usei } }).source).toMatch(
        /mkw\(a0\);\s+usei\(a0 \+ 1\);/,
      );
    }
    const getv = {
      params: ['s32'],
      returns: 'Vec2',
      returnLayout: { kind: 'struct' as const, members: ['x', 'y'].map((name) => ({ name, type: 'float' })) },
    };
    const f =
      '00000000 <f>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,20(r1)\n   c:\tstw     r31,12(r1)\n' +
      '  10:\tmr      r31,r3\n  14:\tbl      14 <f+0x14>\n\t\t\t14: R_PPC_REL24\tgetv\n  18:\taddi    r3,r31,1\n' +
      '  1c:\tbl      1c <f+0x1c>\n\t\t\t1c: R_PPC_REL24\tusei\n  20:\tlwz     r0,20(r1)\n  24:\tlwz     r31,12(r1)\n' +
      '  28:\tmtlr    r0\n  2c:\taddi    r1,r1,16\n  30:\tblr\n';
    expect(decompile('f', f, PPC_MWCC, { prototypes: { getv, usei } }).source).toContain('getv(a0);');
  });

  // `void f(void){ mkw(5); other(); }` and `void g(s32 i){ if (i) mkw(i); other(); }` — r0 past
  // `mkw` holds the struct, so a guessed arity for `other` must not read what r0 held before it
  test('a guessed call after one does not take the value its return register held before', () => {
    const mkw = {
      params: ['s32'],
      returns: 'struct W1',
      returnLayout: { kind: 'struct' as const, members: [{ name: 'x', type: 'u32' }] },
    };
    const f = 'f:\n\tpush\t{lr}\n\tmov\tr0, #0x5\n\tbl\tmkw\n\tbl\tother\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('f', f, ARMV4T_AGBCC, { prototypes: { mkw } }).source).toMatch(/mkw\(5\);\s+other\(\);/);
    const g = 'g:\n\tpush\t{lr}\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tbl\tmkw\n.L3:\n\tbl\tother\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('g', g, ARMV4T_AGBCC, { prototypes: { mkw } }).source).toMatch(/mkw\(a0\);\s+other\(\);/);
    // mwcc_242_81: `GXColor getcol(s32); void f(s32 i){ getcol(i); other(); }`
    const getcol = {
      params: ['s32'],
      returns: 'GXColor',
      returnLayout: { kind: 'struct' as const, members: ['r', 'g', 'b', 'a'].map((name) => ({ name, type: 'u8' })) },
    };
    const ppc =
      '00000000 <f>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,20(r1)\n' +
      '   c:\tbl      c <f+0xc>\n\t\t\tc: R_PPC_REL24\tgetcol\n  10:\tbl      10 <f+0x10>\n' +
      '\t\t\t10: R_PPC_REL24\tother\n  14:\tlwz     r0,20(r1)\n  18:\tmtlr    r0\n  1c:\taddi    r1,r1,16\n  20:\tblr\n';
    const lifted = decompile('f', ppc, PPC_MWCC, { prototypes: { getcol } }).source;
    expect(lifted).toContain('getcol(a0);');
    expect(lifted).toMatch(/other\(\)/);
  });

  // `struct W1 fillw(s32 *); void f(void){ s32 v; fillw(&v); usei(v); }` — agbcc hands W1 back in
  // r0, so the frame word at argument 0 is an out-parameter, not the storage of a return
  test('one that comes back in the return register takes a frame word as an out-parameter', () => {
    const fillw = {
      params: ['s32 *'],
      returns: 'struct W1',
      returnLayout: { kind: 'struct' as const, members: [{ name: 'x', type: 'u32' }] },
    };
    const f =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tbl\tfillw\n\tldr\tr0, [sp]\n\tbl\tusei\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
    const usei = { params: ['s32'], returnsVoid: true as const };
    expect(decompile('f', f, ARMV4T_AGBCC, { prototypes: { fillw, usei } }).source).toMatch(
      /fillw\(&sp0\);\s+usei\(sp0\);/,
    );
  });

  test('a PowerPC call to one not known to come back in registers declines', () => {
    const asm =
      '7c <p4>:\n7c:\tstwu    r1,-16(r1)\n80:\tmflr    r0\n84:\tlis     r3,0\n\t\t\t86: R_PPC_ADDR16_HA\tgDst\n' +
      '88:\tlis     r4,0\n\t\t\t8a: R_PPC_ADDR16_HA\tgBlob\n8c:\tstw     r0,20(r1)\n90:\taddi    r3,r3,0\n' +
      '\t\t\t92: R_PPC_ADDR16_LO\tgDst\n94:\taddi    r4,r4,0\n\t\t\t96: R_PPC_ADDR16_LO\tgBlob\n' +
      '98:\tbl      98 <p4+0x1c>\n\t\t\t98: R_PPC_REL24\tmakeblob\n9c:\tlwz     r0,20(r1)\na0:\tmtlr    r0\n' +
      'a4:\taddi    r1,r1,16\na8:\tblr\n';
    const makeblob = { params: ['const void *'], returns: 'struct Blob64' };
    expect(() => decompile('p4', asm, PPC_MWCC, { prototypes: { makeblob } })).toThrow(
      /'makeblob' is declared to return struct Blob64 by value/,
    );
  });
});

// THE CALLEE HALF IS NOT MODELLED on any frontend (pipeline.ts `refuseOwnStructReturnThroughMemory`). agbcc's
// `struct S8 rmk8(s32 x){ struct S8 s; s.a = x; s.b = x + 1; return s; }` stores through the r0 it
// was handed, and lifted as is it is `s32 *rmk8(s32 *a0, s32 a1)`; mwcc_242_81's `rmk12`, a
// 12-byte struct, stores through r3. A struct that comes back in r0 (agbcc's `struct S1 { u32 x; }`)
// is the lift's own return.
describe('a function that itself returns a struct', () => {
  const u32s = (...names: string[]) => ({
    kind: 'struct' as const,
    members: names.map((name) => ({ name, type: 'u32' })),
  });
  test('through memory, it refuses where its declaration is stated, on agbcc', () => {
    const rmk8 = 'rmk8:\n\tadd\tr2, r1, #0\n\tadd\tr3, r1, #0x1\n\tstr\tr2, [r0]\n\tstr\tr3, [r0, #0x4]\n\tbx\tlr\n';
    const prototypes = { rmk8: { params: ['s32'], returns: 'struct S8', returnLayout: u32s('a', 'b') } };
    expect(() => decompile('rmk8', rmk8, ARMV4T_AGBCC, { prototypes })).toThrow(
      /cannot lift 'rmk8': it is declared to return struct S8 by value, and this target returns that through a hidden pointer in r0/,
    );
    expect(decompile('rmk8', rmk8, ARMV4T_AGBCC, {}).source).toMatch(/s32 \* rmk8\(s32 \*a0, s32 a1\)/);
  });

  test('through memory, it refuses where its declaration is stated, on mwcc', () => {
    const rmk12 =
      '14 <rmk12>:\n14:\tstwu    r1,-32(r1)\n18:\taddi    r5,r4,1\n1c:\taddi    r0,r4,2\n20:\tstw     r4,0(r3)\n' +
      '24:\tstw     r5,4(r3)\n28:\tstw     r4,8(r1)\n2c:\tstw     r5,12(r1)\n30:\tstw     r0,16(r1)\n' +
      '34:\tstw     r0,8(r3)\n38:\taddi    r1,r1,32\n3c:\tblr\n';
    const prototypes = { rmk12: { params: ['s32'], returns: 'struct S12', returnLayout: u32s('a', 'b', 'c') } };
    expect(() => decompile('rmk12', rmk12, PPC_MWCC, { prototypes })).toThrow(
      /cannot lift 'rmk12': it is declared to return struct S12 by value, and this target returns that through a hidden pointer in r3/,
    );
  });

  test('in the return register, it lifts', () => {
    const rmk1 = 'rmk1:\n\tadd\tr0, r0, #0x1\n\tbx\tlr\n';
    const prototypes = { rmk1: { params: ['s32'], returns: 'struct S1', returnLayout: u32s('x') } };
    expect(decompile('rmk1', rmk1, ARMV4T_AGBCC, { prototypes }).source).toMatch(/return a0 \+ 1;/);
  });

  // A `--proto` table spells the return and lays nothing out; the context it is lifted beside does
  // (`withOwnReturnLayout`), for a tag and for a typedef name alike
  const CTX = 'typedef unsigned int u32;\nstruct S1 { u32 x; };\ntypedef struct { u32 a, b; } T8;\n';
  const rmk1 = 'rmk1:\n\tadd\tr0, r0, #0x1\n\tbx\tlr\n';

  test('a stated tag the context lays out in the return register lifts, and unsized it says what is missing', () => {
    const stated = { rmk1: { params: ['s32'], returns: 'struct S1' } };
    const prototypes = withOwnReturnLayout(stated, 'rmk1', CTX, 'c');
    expect(prototypes?.rmk1?.returnLayout).toEqual(u32s('x'));
    expect(decompile('rmk1', rmk1, ARMV4T_AGBCC, { prototypes }).source).toMatch(/return a0 \+ 1;/);
    expect(() => decompile('rmk1', rmk1, ARMV4T_AGBCC, { prototypes: stated })).toThrow(
      /it is declared to return struct S1 by value, and nothing here lays it out, and this target's rule needs its layout/,
    );
  });

  test('a stated typedef of a struct is that struct, and refuses where it comes back through memory', () => {
    const rt8 = 'rt8:\n\tadd\tr2, r1, #0x1\n\tstr\tr2, [r0]\n\tstr\tr1, [r0, #0x4]\n\tbx\tlr\n';
    const prototypes = withOwnReturnLayout({ rt8: { params: ['s32'], returns: 'T8' } }, 'rt8', CTX, 'c');
    expect(prototypes?.rt8?.returnLayout).toEqual(u32s('a', 'b'));
    expect(() => decompile('rt8', rt8, ARMV4T_AGBCC, { prototypes })).toThrow(
      /cannot lift 'rt8': it is declared to return T8 by value, and this target returns that through a hidden pointer in r0/,
    );
  });

  test('a scalar, a pointer or a name the context does not lay out is left as stated', () => {
    const stated = { f: { returns: 'u32' }, g: { returns: 'struct S1 *' }, h: { returns: 'BOOL' } };
    for (const name of ['f', 'g', 'h']) {
      expect(withOwnReturnLayout(stated, name, CTX, 'c')).toBe(stated);
    }
  });

  // mwcc's svr4 rule hands an eight-byte struct back in r3:r4, and the lift returns r3 alone
  test('in a register pair, it refuses', () => {
    const rmk8 = '0 <rmk8>:\n0:\taddi    r4,r3,0\n4:\taddi    r3,r3,1\n8:\tblr\n';
    const prototypes = { rmk8: { params: ['s32'], returns: 'struct S8', returnLayout: u32s('a', 'b') } };
    expect(() => decompile('rmk8', rmk8, PPC_MWCC, { prototypes })).toThrow(
      /it is declared to return struct S8 by value, and this target hands its 8 bytes back in two registers/,
    );
  });
});
