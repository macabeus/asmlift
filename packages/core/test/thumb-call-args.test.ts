// Thumb frontend: what an undeclared or declared call is handed — an escaping frame address, an
// incoming stack argument re-read in a loop, a gap in the argument registers, a variadic floor.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';
import { dc } from './helpers';

// A FRAME ADDRESS HANDED OUT IS READ BY ITS RECEIVER, at any frame size. Every fixture is agbcc
// 2.9-arm-000512's own output at `-mthumb-interwork -O2 -fhex-asm`, for
// `struct S { int a; int b; unsigned char c; unsigned short d; }`.
describe('a frame address that escapes explains the stores it hands over', () => {
  const G = { g: { params: ['struct S *'], returns: 's32' } };
  const H5 = { h5: { params: ['s32', 's32', 's32', 's32', 's32'], returns: 's32' } };
  // `int f0(int x, int y){ struct S s; s.a = 0; s.b = x; s.c = 0; s.d = y; return g(&s); }`
  const f0 =
    'f0:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr2, #0x0\n\tstr\tr2, [sp]\n\tstr\tr0, [sp, #0x4]\n' +
    '\tmov\tr0, sp\n\tstrb\tr2, [r0, #0x8]\n\tstrh\tr1, [r0, #0xa]\n\tbl\tg\n\tadd\tsp, sp, #0xc\n\tpop\t{r1}\n\tbx\tr1\n';
  // …the same, then `return h5(1, 2, 3, 4, x);`: the object moves above the outgoing word
  const f1 =
    'f1:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr4, r0, #0\n\tmov\tr2, #0x0\n\tstr\tr2, [sp, #0x4]\n' +
    '\tstr\tr4, [sp, #0x8]\n\tadd\tr0, sp, #0x4\n\tstrb\tr2, [r0, #0x8]\n\tstrh\tr1, [r0, #0xa]\n\tbl\tg\n' +
    '\tstr\tr4, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\th5\n' +
    '\tadd\tsp, sp, #0x10\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';

  test('a wide frame-base object filled for its callee lifts with every store', () => {
    expect(decompile('f0', f0, ARMV4T_AGBCC, { prototypes: G }).source).toBe(
      's32 f0(s32 a0, s32 a1) {\n    u8 sp0[12];\n    s32 *p0;\n    p0 = (s32 *)sp0;\n    *p0 = 0;\n' +
        '    p0[1] = a0;\n    ((u8 *)sp0)[8] = 0;\n    ((u16 *)sp0)[5] = a1;\n    return g(sp0);\n}\n',
    );
  });

  test('…and an object above a declared outgoing word is the object, not a sixth argument', () => {
    expect(decompile('f1', f1, ARMV4T_AGBCC, { prototypes: { ...G, ...H5 } }).source).toContain(
      '    g(sp4);\n    return h5(1, 2, 3, 4, a0);\n',
    );
  });

  // The register carries the address only where the callee's declaration reads it: `g` declared
  // with no parameter is handed nothing, so the store keeps its old reading.
  test('a register past the declared arity hands nothing over', () => {
    expect(() => decompile('f0', f0, ARMV4T_AGBCC, { prototypes: { g: { params: [], returns: 's32' } } })).toThrow(
      /the store to \[sp,#0\] is never reloaded/,
    );
  });

  // The premise is read only where a call MAY take a stack word, here `g` undeclared. With `g`
  // declared no call takes one, so there is no outgoing area on any compiler and the escaping
  // frame base is a local's address without the premise (thumb.ts, beside `noCallTakesAStackWord`).
  test('an armv4t compiler that has not declared the premise does not get it', () => {
    const { escapedFrameAddressNamesALocal: _unprobed, ...behaviors } = ARMV4T_AGBCC.compilerBehaviors;
    const undeclared = { ...ARMV4T_AGBCC, compiler: 'sdt', compilerBehaviors: behaviors };
    expect(() => decompile('f0', f0, undeclared)).toThrow(/the store to \[sp,#0\] is never reloaded/);
    expect(() => decompile('f0', f0, ARMV4T_AGBCC)).not.toThrow(/never reloaded/);
    expect(decompile('f0', f0, undeclared, { prototypes: G }).source).toBe(
      decompile('f0', f0, ARMV4T_AGBCC, { prototypes: G }).source,
    );
  });

  // THE OTHER PRODUCER OF A HANDED-OUT FRAME BASE: `void qh5(struct H *p, int x){ th(*p);
  // h5(1, 2, 3, 4, x); }` with `struct H { int a[17]; }` — `mov r0, sp` is memcpy's destination,
  // the block copy of `th`'s stack words, and `h5`'s fifth is staged after it.
  const qh5 =
    'qh5:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x34\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tadd\tr1, r4, #0\n' +
    '\tadd\tr1, r1, #0x10\n\tmov\tr0, sp\n\tmov\tr2, #0x34\n\tbl\tmemcpy\n\tldr\tr0, [r4]\n\tldr\tr1, [r4, #0x4]\n' +
    '\tldr\tr2, [r4, #0x8]\n\tldr\tr3, [r4, #0xc]\n\tbl\tth\n\tstr\tr5, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n' +
    '\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\th5\n\tadd\tsp, sp, #0x34\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';

  test('a block-copy base handed to memcpy still leaves the later staged word declining', () => {
    expect(() => decompile('qh5', qh5, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] reaches `bl h5` unread/);
    expect(() => decompile('qh5', qh5, ARMV4T_AGBCC, { prototypes: H5 })).toThrow(
      /the frame address \[sp,#0\] escapes this function, so the words from there up are an object's, and the two name the same word/,
    );
  });

  // THE EVENT READ TWO WAYS (`escapedFrameAddressNamesALocal`). `struct T { int a, b, c; }`:
  // `t.a = x; t.b = y; t.c = 1; if (x) gt(&t); return t.b;` stores the object on a path that never
  // escapes, and no call follows those stores there, so condition (a)'s whole-function reading
  // excuses them and it lifts. `t.a = x; gp = &t; t.b = y; t.c = 2; return hy(x);` stores after the
  // publish, and those words reach `hy` pending: the per-point reading refuses them there.
  test('a store no call follows is excused whole-function, and one that reaches a call is not', () => {
    const T = { gt: { params: ['struct T *'], returns: 's32' }, hy: { params: ['s32'], returns: 's32' } };
    const e3 =
      'e3:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tmov\tr1, #0x1\n' +
      '\tstr\tr1, [sp, #0x8]\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tmov\tr0, sp\n\tbl\tgt\n.L3:\n\tldr\tr0, [sp, #0x4]\n' +
      '\tadd\tsp, sp, #0xc\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('e3', e3, ARMV4T_AGBCC, { prototypes: T }).source).toContain(
      '    if (a0 != 0) gt(sp0);\n    return ((s32 *)sp0)[1];\n',
    );
    const s3 =
      's3:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tldr\tr2, .L5\n\tmov\tr3, sp\n\tstr\tr3, [r2]\n' +
      '\tstr\tr1, [sp, #0x4]\n\tmov\tr1, #0x2\n\tstr\tr1, [sp, #0x8]\n\tbl\thy\n\tadd\tsp, sp, #0xc\n\tpop\t{r1}\n' +
      '\tbx\tr1\n.L6:\n\t.align\t2, 0\n.L5:\n\t.word\tgp\n';
    // `hy` takes its one word in a register, so no call takes a stack word and the published frame
    // base is a local's address: the frame model refuses the words stored after the publish as
    // slots a reader of that address may write, before the event is read. Still loud.
    expect(() => decompile('s3', s3, ARMV4T_AGBCC, { prototypes: T })).toThrow(
      /the captured address at \[sp,#0\) is stored to memory, which may write the slot at \[sp,#4\]/,
    );
  });

  // By-value struct fifth arguments, which no capture stages: `tw2(1, 2, 3, 4, *p)` over
  // `struct W2 { int a, b; }` is two `str`s; over a 6-word struct it is `mov r1, sp` + ldmia/stmia.
  test('a by-value struct argument keeps its decline', () => {
    const q2 =
      'q2:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tldr\tr1, [r0, #0x4]\n\tldr\tr0, [r0]\n\tstr\tr0, [sp]\n' +
      '\tstr\tr1, [sp, #0x4]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\ttw2\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('q2', q2, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] is never reloaded/);
    const q6 =
      'q6:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x18\n\tmov\tr1, sp\n\tldmia\tr0!, {r2, r3, r4}\n' +
      '\tstmia\tr1!, {r2, r3, r4}\n\tldmia\tr0!, {r2, r3, r4}\n\tstmia\tr1!, {r2, r3, r4}\n\tmov\tr0, #0x1\n' +
      '\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\ttw6\n\tadd\tsp, sp, #0x18\n\tpop\t{r4}\n' +
      '\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('q6', q6, ARMV4T_AGBCC)).toThrow(
      /the 4-byte store at \[sp,#0\) through a captured address reaches the call to `tw6` unread on every path/,
    );
  });
});

// AN INCOMING STACK ARGUMENT READ OUTSIDE THE ENTRY BLOCK. Its index is the offset less the frame
// depth, and the depth there is one number only where nothing but the prologue and a returning
// tail moves sp (`frameDepthBlocker`).
describe('an incoming stack argument re-read in a loop is the parameter', () => {
  const put = { put: { params: ['s32', 's32'], returnsVoid: true } };
  // agbcc's own output for `void sum5(int a, int b, int c, int d, const unsigned char *e, int n)
  // { int i; for (i = 0; i < n; i++) put(a + e[i], b + c + d); }`: `e` is re-read in the loop.
  const sum5 = (loopHead: string, loopTail: string) =>
    'sum5:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, r8\n\tpush\t{r7}\n\tmov\tr8, r0\n\tadd\tr7, r3, #0\n' +
    '\tldr\tr6, [sp, #0x1c]\n\tmov\tr4, #0x0\n\tcmp\tr4, r6\n\tbge\t.L4\n\tadd\tr5, r1, r2\n' +
    `.L6:\n${loopHead}\tldr\tr1, [sp, #0x18]\n\tadd\tr0, r1, r4\n\tldrb\tr0, [r0]\n\tadd\tr0, r0, r8\n` +
    `\tadd\tr1, r5, r7\n\tbl\tput\n${loopTail}\tadd\tr4, r4, #0x1\n\tcmp\tr4, r6\n\tblt\t.L6\n` +
    '.L4:\n\tpop\t{r3}\n\tmov\tr8, r3\n\tpop\t{r4, r5, r6, r7}\n\tpop\t{r0}\n\tbx\tr0\n';

  test('the read in the loop block is argument 5', () => {
    expect(decompile('sum5', sum5('', ''), ARMV4T_AGBCC, { prototypes: put }).source).toBe(
      'void sum5(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n    s32 v0;\n' +
        '    for (v0 = 0; v0 < a5; v0 = v0 + 1) {\n        put(*(u8 *)(a4 + v0) + a0, a1 + a2 + a3);\n    }\n}\n',
    );
  });

  test('…and so is a read in any block after a settled prologue', () => {
    const later =
      '\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tmov\tr0, #1\n\tbx\tlr\n.L1:\n\tldr\tr0, [sp, #8]\n\tbx\tlr\n';
    expect(dc('f', later).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    if (a0 != 0) {\n        return 1;\n    } else {\n        return a4;\n    }\n}\n',
    );
  });

  test('a loop block that moves sp itself declines', () => {
    const moved = sum5('\tadd\tsp, sp, #-0x8\n', '\tadd\tsp, sp, #0x8\n');
    expect(() => decompile('sum5', moved, ARMV4T_AGBCC, { prototypes: put })).toThrow(
      /stack pointer used as data — a non-entry block establishes its own frame depth/,
    );
  });

  // A branch back to the first instruction runs the prologue's `push` again, so no block after it
  // has one depth.
  test('a function whose entry is a loop target declines', () => {
    const again =
      'again:\n\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.L12\n\tldr\tr0, [sp, #0x8]\n' +
      '\tsub\tr0, r0, #1\n\tb\tagain\n.L12:\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('again', again, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });
});

// A PASS-THROUGH ARGUMENT AN UNDECLARED ARITY CANNOT SEE. The guessed count stops at the first
// argument register this function did not write, and an incoming argument the call is handed
// unchanged is one. agbcc's own output for `int logv(); int pr(const char *s){ return logv(s, 1) + 1; }`
// sets r1 alone and leaves `s` in r0, so a count that stops at r0 lifts it as `logv() + 1`. A later
// register holding a value says the call takes arguments past the gap, and which ones is not
// decidable, so the guess refuses (frontend/call-arity.ts `fallbackArgc`), naming the call by its block.
// A GAP IN THE ARGUMENT REGISTERS OF AN UNDECLARED CALL is decided where the register above it is
// surely an argument (frontend/call-plan.ts `decideGap`): the call's own block set it to a value no
// memory read produced, which nothing else reads, and agbcc fills argument words in order — so the
// gap holds this function's incoming arguments, passed on. agbcc's own output for each source.
describe('a gap in the argument registers of an undeclared call', () => {
  // `int logv(); int passgap(const char *s){ return logv(s, 1) + 1; }`
  const PR = 'pr:\n\tpush\t{lr}\n\tmov\tr1, #0x1\n\tbl\tlogv\n\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n';
  const GAP =
    /cannot lift '(\w+)': the call 'bl \w+' in block '\w+' has no prototype, r(\d) holds a value and r0 holds none/;

  test('a pass-through first argument before a set-up second one is passed', () => {
    expect(decompile('pr', PR, ARMV4T_AGBCC).source).toContain('return logv(a0, 1) + 1;');
  });

  // `int logv(fmt, ...)`: a variadic declaration states its fixed word, so r0 is passed as stated
  // and only what the `...` takes is guessed — `1`, in r1. An unsized fixed parameter states no
  // word, and the guess from r0 decides the gap as for an undeclared callee.
  test('…and the same call to a callee declared variadic passes its stated fixed word', () => {
    const variadic = (fixed: string) =>
      decompile('pr', PR, ARMV4T_AGBCC, { prototypes: { logv: { returns: 's32', variadicParams: [fixed] } } }).source;
    expect(variadic('const char *')).toContain('logv(a0, 1) + 1');
    expect(variadic('Fmt')).toContain('logv(a0, 1) + 1');
  });

  // CONTROL: a declaration that states the arity passes both
  test('a declaration that states the arity passes it', () => {
    expect(decompile('pr', PR, ARMV4T_AGBCC, { prototypes: { logv: { params: 2 } } }).source).toContain(
      'return logv(a0, 1) + 1;',
    );
  });

  // `int g3(); int mid(int a, int b){ return g3(1, b, 3) + 1; }`: r0 and r2 set, `b` left in r1
  test('a pass-through argument between set-up ones is passed', () => {
    const mid =
      'mid:\n\tpush\t{lr}\n\tmov\tr0, #0x1\n\tmov\tr2, #0x3\n\tbl\tg3\n\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('mid', mid, ARMV4T_AGBCC).source).toContain('return g3(1, a1, 3) + 1;');
  });

  // `int g(); int fvol(int s){ *(volatile int *)0x4000000; return g(s) + 1; }`: agbcc puts a
  // DISCARDED volatile read in the lowest free argument register, so r1 holds a value only the call
  // reads and `g(s)` is the source. A memory read proves nothing.
  test('a value a memory read left in the register above does not decide the gap', () => {
    const fvol =
      'fvol:\n\tpush\t{lr}\n\tmov\tr1, #0x80\n\tlsl\tr1, r1, #0x13\n\tldr\tr1, [r1]\n\tbl\tg\n' +
      '\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('fvol', fvol, ARMV4T_AGBCC)).toThrow(GAP);
  });

  // `struct T { int x, y, z; }; int logv(); int fwb(const char *s, int n, struct T *p, struct T *q){
  // *p = *q; return logv(s, n) + 1; }`: agbcc's block copy leaves both advanced bases dead in r2/r3,
  // pure adds only the call reads. A writeback is no evidence that anything wanted the value
  // (`SsaBuilder.noteIncidentalWrite`); read as arguments it would lift `logv(a0, a1, a2 + 3, a3 + 3)`.
  test('a base writeback left in the register above does not decide the gap', () => {
    const fwb =
      'fwb:\n\tpush\t{r4, r5, r6, lr}\n\tldmia\tr3!, {r4, r5, r6}\n\tstmia\tr2!, {r4, r5, r6}\n\tbl\tlogv\n' +
      '\tadd\tr0, r0, #0x1\n\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('fwb', fwb, ARMV4T_AGBCC)).toThrow(/r2 holds a value and r0 holds none/);
  });

  // `int logv(); int gx; int fst2(const char *s){ gx = 1; return logv(s, 1) + 1; }` is one object with
  // `gx = 1; return logv(s) + 1;`: the stored constant stays in r1, so a value something else reads
  // decides nothing. `int fkeep(const char *s, int c){ int t = c * 3; int r = logv(s, t); return r
  // + t; }` refuses too, but it is NO counterexample. It keeps `t` in r4 and copies it to r1, and
  // `logv(s)` compiles without that `add r1, r4, #0` (likewise `mr r4,r31` on mwcc and `move a1,s0`
  // on KMC), so the copy has no reader but the call and the bytes do decide it. The proof object is
  // the SSA value (`requireSoleReader`), which the later read shares, and a register copy is folded
  // away. A KNOWN GAP: a copy into the register above never decides, at the cost of a decline, not
  // wrong C.
  test('a value something besides the call reads does not decide the gap', () => {
    const fst2 =
      'fst2:\n\tpush\t{lr}\n\tldr\tr2, .L4\n\tmov\tr1, #0x1\n\tstr\tr1, [r2]\n\tbl\tlogv\n' +
      '\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n.L5:\n.L4:\n\t.word\tgx\n';
    expect(() => decompile('fst2', fst2, ARMV4T_AGBCC)).toThrow(GAP);
    const fkeep =
      'fkeep:\n\tpush\t{r4, lr}\n\tlsl\tr4, r1, #0x1\n\tadd\tr4, r4, r1\n\tadd\tr1, r4, #0\n\tbl\tlogv\n' +
      '\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('fkeep', fkeep, ARMV4T_AGBCC)).toThrow(GAP);
  });

  // A gap register a call destroyed holds nothing: `bl h` leaves r0 holding h's result, which is
  // set up, so no gap; one it leaves holding nothing past the return register — r1 here, read by
  // nothing — is no incoming argument, and the gap below r2 refuses.
  test('a gap register an earlier call destroyed does not hold the incoming value', () => {
    const after = 'after:\n\tpush\t{lr}\n\tbl\th\n\tmov\tr2, #0x3\n\tbl\tg3\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('after', after, ARMV4T_AGBCC)).toThrow(/r2 holds a value and r1 holds none/);
  });

  // where the own declaration binds the body, the gap register must be one of its parameters
  test('a gap register the own declaration does not give a parameter refuses', () => {
    expect(() => decompile('pr', PR, ARMV4T_AGBCC, { prototypes: { pr: { params: [], returns: 's32' } } })).toThrow(
      GAP,
    );
    expect(
      decompile('pr', PR, ARMV4T_AGBCC, { prototypes: { pr: { params: ['const char *'], returns: 's32' } } }).source,
    ).toContain('return logv(a0, 1) + 1;');
  });

  // THE BOUNDARY. `int g2(); int allp(int a, int b){ return g2(a, b) + 1; }` passes both arguments
  // through and sets nothing up: it is the same machine code as `g2()`, so there is no gap to see,
  // and the guess lifts the shorter call.
  test('a run of pass-through arguments with nothing set up past it is no gap', () => {
    const allp = 'allp:\n\tpush\t{lr}\n\tbl\tg2\n\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('allp', allp, ARMV4T_AGBCC).source).toContain('return g2() + 1;');
  });

  // A Thumb instruction has no address, so the refusal names the call where the .s puts it. A block
  // the splitter opened after a branch has a made-up label no .s spells, so a call there is named
  // within the function — by its ordinal where the function calls the same callee more than once.
  // `int logv(); int loc(const char *s, int c){ if (c == 0) return 0; return logv(s, 1); }` decides
  // its gap (the entry value of r0 reaches the call on its one path); the loaded `1` does not.
  test('a call in a block the .s does not label is named within its function', () => {
    const loc = (set: string, other: string) =>
      `loc:\n\tpush\t{lr}\n\tcmp\tr1, #0x0\n\tbeq\t.L2\n${set}\tbl\tlogv\n\tb\t.L3\n` +
      `.L2:\n${other}.L3:\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(decompile('loc', loc('\tmov\tr1, #0x1\n', '\tmov\tr0, #0x0\n'), ARMV4T_AGBCC).source).toContain(
      'logv(a0, 1)',
    );
    expect(() => decompile('loc', loc('\tldr\tr1, [r2]\n', '\tmov\tr0, #0x0\n'), ARMV4T_AGBCC)).toThrow(
      /the call 'bl logv' in 'loc' has no prototype, r1 holds a value/,
    );
    expect(() => decompile('loc', loc('\tldr\tr1, [r2]\n', '\tmov\tr1, #0x2\n\tbl\tlogv\n'), ARMV4T_AGBCC)).toThrow(
      /the call 'bl logv' in 'loc' \(the 1st of its 2 calls there\) has no prototype/,
    );
  });
});

// PAST A VARIADIC DECLARATION'S STATED WORDS, A REGISTER HOLDING ONLY THIS FUNCTION'S OWN INCOMING
// VALUE REFUSES (frontend/call-arity.ts `fallbackArgc`): a read leaves the entry value behind as a
// definition, and whether the call is handed it is not decidable. agbcc's own output for
// `int dprint(const char *, ...);` and each source below. The value a call destroyed reaches only
// through that call, and the copy that re-sets the register sets it up, so neither is the entry
// value still standing.
describe('an incoming value past a variadic floor', () => {
  const dprint = { returns: 's32', variadicParams: ['const char *'] };
  const lift = (sym: string, body: string, g: string[] = []) =>
    decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC, { prototypes: { dprint, g: { params: g, returns: 's32' } } })
      .source;
  const EPI = '\tpop\t{r1}\n\tbx\tr1\n';

  // `int pr1(const char *s, int x){ if (x) return dprint(s) + 1; return 0; }`: r1 is read only
  test('refuses a register the function only read', () => {
    const body =
      '\tpush\t{lr}\n\tcmp\tr1, #0\n\tbne\t.L3\n\tmov\tr0, #0x0\n\tb\t.L4\n.L3:\n\tbl\tdprint\n' +
      `\tadd\tr0, r0, #0x1\n.L4:\n${EPI}`;
    expect(() => lift('pr1', body)).toThrow(
      /the call 'bl dprint' in block '.L3' has a prototype stating only its first 1 argument, and r1 past them still holds this function's own incoming value/,
    );
  });

  // `void rl3(const char *s, int x){ g(x); dprint(s); }`: `g` destroyed r1
  test('passes nothing a call destroyed', () => {
    const body =
      '\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tadd\tr0, r1, #0\n\tbl\tg\n\tadd\tr0, r4, #0\n\tbl\tdprint\n' +
      '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const out = lift('rl3', body, ['s32']);
    expect(out).toContain('g(a1);');
    expect(out).toContain('dprint(a0);');
  });

  // `int rl1(const char *s, int x){ g(); if (x) return dprint(s) + 1; return 0; }`: read, but a call
  // destroyed it on the way
  test('passes nothing a call destroyed after the read', () => {
    const body =
      '\tpush\t{r4, r5, lr}\n\tadd\tr5, r0, #0\n\tadd\tr4, r1, #0\n\tbl\tg\n\tcmp\tr4, #0\n\tbne\t.L3\n' +
      '\tmov\tr0, #0x0\n\tb\t.L4\n.L3:\n\tadd\tr0, r5, #0\n\tbl\tdprint\n\tadd\tr0, r0, #0x1\n.L4:\n' +
      `\tpop\t{r4, r5}\n${EPI}`;
    expect(lift('rl1', body)).toContain('dprint(a0) + 1');
  });

  // `int rl2(const char *s, int x, int y){ int r = g(y); if (x) return dprint(s) + r; return 0; }`
  test('passes nothing a call destroyed, with its result kept', () => {
    const body =
      '\tpush\t{r4, r5, r6, lr}\n\tadd\tr6, r0, #0\n\tadd\tr4, r1, #0\n\tadd\tr0, r2, #0\n\tbl\tg\n' +
      '\tadd\tr5, r0, #0\n\tcmp\tr4, #0\n\tbne\t.L3\n\tmov\tr0, #0x0\n\tb\t.L4\n.L3:\n\tadd\tr0, r6, #0\n' +
      `\tbl\tdprint\n\tadd\tr0, r0, r5\n.L4:\n\tpop\t{r4, r5, r6}\n${EPI}`;
    const out = lift('rl2', body, ['s32']);
    expect(out).toContain('g(a2)');
    expect(out).toMatch(/dprint\(a0\) \+ v\d/);
  });

  // `void rl4(const char *s, int x, int y){ g(y); dprint(s, x); }`: r1 re-set from a saved copy is
  // set up here, whatever value SSA names it
  test('passes a register re-set since the last call', () => {
    const body =
      '\tpush\t{r4, r5, lr}\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tadd\tr0, r2, #0\n\tbl\tg\n' +
      '\tadd\tr0, r4, #0\n\tadd\tr1, r5, #0\n\tbl\tdprint\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(lift('rl4', body, ['s32'])).toContain('dprint(a0, a1);');
  });
});

// A DECLARATION THE LOWERING CANNOT LAY OUT STILL BOUNDS OR REFUSES THE GUESS. Where the arity falls
// to the guess behind a declaration, a trailing argument passed through unchanged leaves no gap for
// `fallbackArgc` to see: agbcc's `g(a + 1, b)` sets r0 and leaves `b` in r1, the bytes of `g(a + 1)`.
describe('a declared callee whose parameters are not laid out does not lose its arguments to the guess', () => {
  const FJ = 'fj:\n\tpush\t{lr}\n\tadd\tr0, #0x1\n\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n';
  const lift = (prototypes: Prototypes) => decompile('fj', FJ, ARMV4T_AGBCC, { prototypes }).source;

  // agbcc has no FPU, and lays out a `double` in general words but not a `float` or a `long double`:
  // the guess would lift `int g(int, float);`'s call as `g(a0 + 1)`, and `float h(float);`'s `h(v)`
  // as `h(a1, a1)`
  test('a parameter declared float or long double refuses on agbcc', () => {
    for (const t of ['float', 'f32', 'long double']) {
      expect(() => lift({ g: { params: ['s32', t], returns: 's32' } })).toThrow(
        new RegExp(`\`g\` is declared to take '${t}' as its parameter 2, which this target passes in general`),
      );
    }
    // CONTROL: a `double` is laid out, as two words
    expect(lift({ g: { params: ['s32', 'double'], returns: 's32' } })).toContain('g(a0 + 1, ');
  });

  // `void h(int, Foo);` with `Foo` unresolved: the list is unsized, the guess stands in, and it
  // counts one register for a declaration of two
  test('a guess shorter than an unsized declaration refuses', () => {
    expect(() => lift({ g: { params: ['s32', 'Foo'], returns: 's32' } })).toThrow(
      /`g` is declared with 2 parameters, which no layout here places, and the arity guess in its place finds 1 argument register set up/,
    );
    // CONTROL: one set up past r0 meets the count, and an unsized parameter may be wider, so it lifts
    const both = 'fj:\n\tpush\t{lr}\n\tadd\tr0, #0x1\n\tadd\tr1, #0x2\n\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(
      decompile('fj', both, ARMV4T_AGBCC, { prototypes: { g: { params: ['s32', 'Foo'], returns: 's32' } } }).source,
    ).toContain('g(a0 + 1, a1 + 2)');
  });

  // `int logv(const char *, int, ...); int vs(const char *s, int c){ return logv(s + 1, c); }`: the
  // fixed parameters are each one word, so they are the first two argument words, and the guess
  // stands in only for what the `...` takes, above them
  test('a variadic declaration`s one-word fixed parameters are read as stated, and only the rest is guessed', () => {
    expect(lift({ g: { returns: 's32', variadicParams: ['const char *', 's32'] } })).toContain('g(a0 + 1, a1)');
    // past the fixed words the guess decides a gap as it does from r0: r3 set up above an r2 left at
    // its incoming value passes r2 on (`decideGap`), and one a memory read set refuses
    const gap = (set: string) => `fj:\n\tpush\t{lr}\n${set}\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n`;
    const variadic = (set: string) =>
      decompile('fj', gap(set), ARMV4T_AGBCC, {
        prototypes: { g: { returns: 's32', variadicParams: ['const char *', 's32'] } },
      }).source;
    expect(variadic('\tadd\tr3, #0x1\n')).toContain('g(a0, a1, a2, a3 + 1)');
    expect(() => variadic('\tldr\tr3, [r3]\n')).toThrow(
      /has a prototype stating only its first 2 arguments, r3 holds a value and r2 holds none/,
    );
    // a stated fixed word a call destroyed names nothing, and refuses rather than pass the callee's leftover
    const destroyed = 'fj:\n\tpush\t{lr}\n\tadd\tr0, #0x1\n\tbl\th\n\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() =>
      decompile('fj', destroyed, ARMV4T_AGBCC, {
        prototypes: { g: { returns: 's32', variadicParams: ['const char *', 's32'] } },
      }),
    ).toThrow(/r1 is read on a path where a call has destroyed it/);
  });

  // `int logu(const char *, Foo, ...);` with `Foo` unresolved: an unsized fixed parameter may be two
  // words, so it states no floor, and a guess short of the count refuses
  test('a guess shorter than a variadic declaration`s unsized fixed parameters refuses', () => {
    expect(() => lift({ g: { returns: 's32', variadicParams: ['const char *', 'Foo'] } })).toThrow(
      /`g` is declared with 2 fixed parameters before its `...`, which no layout here places/,
    );
  });
});

// A FRAME ADDRESS AN UNDECLARED ARITY LEAVES OUT. The guessed count stops at the first argument
// register this function did not write, and an incoming argument passed on unchanged is one, so a
// capture behind it falls outside the call — and the object it addresses reads as a local nothing
// wrote. A capture past such a register is a GAP, which the guess refuses first (`fallbackArgc`);
// what reaches `leftOut` is a capture past a count that is no gap: the bound of a call through an
// argument register, or a register the trim cuts. agbcc's own output for `typedef int (*F)(int, int, int, unsigned char *);
// int r1(int p0, int p1, int p2, int p3, unsigned char *data, F func) { unsigned char d[4];
// unsigned char *d1 = &d[1]; int res; if (data == 0) data = d; res = func(p0, p1, p2, d1);
// if (res != 0) *data = *d1; return res; }` would lift as `func()` and `*data = sp1`; sa3's
// `sa2__sub_801F07C` is that shape.
describe('a frame address an undeclared arity leaves out refuses', () => {
  const body = (setup: string) =>
    '\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr4, [sp, #0x14]\n\tldr\tr6, [sp, #0x18]\n' +
    '\tmov\tr5, sp\n\tadd\tr5, r5, #0x1\n\tcmp\tr4, #0\n\tbne\t.L3\n\tmov\tr4, sp\n' +
    `.L3:\n${setup}\tadd\tr3, r5, #0\n\tbl\t_call_via_r6\n\tadd\tr1, r0, #0\n\tcmp\tr1, #0\n\tbeq\t.L4\n` +
    '\tldrb\tr0, [r5]\n\tstrb\tr0, [r4]\n.L4:\n\tadd\tr0, r1, #0\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5, r6}\n' +
    '\tpop\t{r1}\n\tbx\tr1\n';

  test('a capture made in an earlier block and left behind passed-on arguments declines', () => {
    expect(() => decompile('r1', `r1:\n${body('')}`, ARMV4T_AGBCC)).toThrow(
      /the call 'bl _call_via_r6' in block '.L3' has no prototype, r3 holds a value and r0 holds none/,
    );
  });

  // CONTROL: `func(p0 + 1, p1 + 1, p2 + 1, d1)` writes every register below the capture, so the
  // count reaches it and the object is passed.
  test('…and the same capture behind written registers is passed', () => {
    const setup = '\tadd\tr0, r0, #0x1\n\tadd\tr1, r1, #0x1\n\tadd\tr2, r2, #0x1\n';
    expect(decompile('r2', `r2:\n${body(setup)}`, ARMV4T_AGBCC).source).toContain(
      '    v0 = ((s32 (*)())a5)(a0 + 1, a1 + 1, a2 + 1, (u32)sp0 + 1);\n    if (v0 != 0) *a4 = ((u8 *)sp0)[1];\n',
    );
  });

  // pokeemerald's `GetMonNickname2`: `GetMonData3(mon, MON_DATA_NICKNAME, nickname)` with `mon`
  // still in r0, which would lift as `GetMonData3()`. The constant in r1 decides the gap below it
  // (`decideGap`), and a declaration states the arity outright.
  const gn =
    'gn:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x14\n\tadd\tr4, r1, #0\n\tmov\tr1, #0x2\n\tmov\tr2, sp\n' +
    '\tbl\tGetMonData3\n\tadd\tr0, r4, #0\n\tmov\tr1, sp\n\tbl\tStringCopy_Nickname\n\tadd\tsp, sp, #0x14\n' +
    '\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
  test('a capture in the calling block above a decided gap is passed, as a declaration passes it', () => {
    expect(decompile('gn', gn, ARMV4T_AGBCC).source).toContain('    GetMonData3(a0, 2, sp0);\n');
    const declared = { GetMonData3: { params: ['void *', 's32', 'u8 *'], returns: 'u32' } };
    expect(decompile('gn', gn, ARMV4T_AGBCC, { prototypes: declared }).source).toContain(
      '    GetMonData3(a0, 2, sp0);\n',
    );
  });

  // A call through r1 passes r0 alone (`argRegisterBoundsArity`), which is only a bound.
  test('a capture above the bound of a call through an argument register declines', () => {
    const bnd =
      'bnd:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tadd\tr2, r4, #0\n\tmov\tr0, #0x1\n' +
      '\tbl\t_call_via_r1\n\tldrb\tr0, [r4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('bnd', bnd, ARMV4T_AGBCC)).toThrow(
      /'bl _call_via_r1' has no prototype, and the arity lifted without one leaves out r2/,
    );
  });

  // r1 is captured into AFTER the first call, so at that call it still holds the caller's value —
  // the flow-insensitive closure (`registersThatMayHoldAFrameAddress`) would say otherwise.
  test('an incoming argument register a later capture reuses does not decline', () => {
    const later =
      'later:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r1, #0\n\tbl\talloc\n\tmov\tr1, sp\n' +
      '\tmov\tr2, #0x0\n\tstrb\tr2, [r1]\n\tadd\tr0, r4, #0\n\tbl\tfill2\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n' +
      '\tpop\t{r1}\n\tbx\tr1\n';
    // `alloc` declared: undeclared, r1 read and r0 not is a gap the guess refuses
    expect(decompile('later', later, ARMV4T_AGBCC, { prototypes: { alloc: { params: 0 } } }).source).toContain(
      '    return fill2(a1, &sp0, 0);\n',
    );
  });

  // THE TRIM SHRINKS A GUESS A SECOND TIME, after the lowering asked. agbcc's own output for
  // `struct S { int a; int b; unsigned char c; unsigned short d; }; long long foo(void); void g();
  // void n1(int x, int y) { struct S s; long long v = foo(); s.a = 0; s.b = x; s.c = 0; s.d = y;
  // g(v, &s); }`: the guess reads four (r1 reaches the call through `foo`'s high half), and the trim
  // cuts it to the run below that unfresh r1, taking `&s` in r2 with it — `g(v0)`, every store to
  // `s` dropped. With both declared it lifts whole.
  const n1 =
    'n1:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0xc\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n\tbl\tfoo\n' +
    '\tmov\tr3, #0x0\n\tstr\tr3, [sp]\n\tstr\tr4, [sp, #0x4]\n\tmov\tr2, sp\n\tstrb\tr3, [r2, #0x8]\n' +
    '\tstrh\tr5, [r2, #0xa]\n\tbl\tg\n\tadd\tsp, sp, #0xc\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';
  test('a capture the trim cuts from a guessed arity declines, and declarations pass it', () => {
    expect(() => decompile('n1', n1, ARMV4T_AGBCC)).toThrow(
      /'bl g' has no prototype, and the arity lifted without one leaves out r2, which may hold a frame address/,
    );
    const declared = {
      foo: { params: [], returns: 's64' },
      g: { params: ['s64', 'struct S *'], returns: 'void' },
    };
    expect(decompile('n1', n1, ARMV4T_AGBCC, { prototypes: declared }).source).toContain('    g(v0, sp0);\n');
  });

  // A FRAME ADDRESS MOVED BY A REGISTER is one too, at an offset nothing knows. agbcc's own output
  // for `extern void g3(); extern unsigned char gb[]; void r5(int a, int b, int i, int j) {
  // unsigned char buf[8]; g3(a, b, &buf[i]); gb[0] = buf[j]; }` builds `&buf[i]` as
  // `add r2, r2, sp`, which would lift as `g3(); gb = sp0[a3];`. The address decides the gap below it
  // (`decideGap`), but r3 above it still holds `j`, read for the copy to r4, and a register the count
  // takes past a decided gap must be proven too, so the gap refuses first (before the audit, which
  // refuses an indexed address a call is handed).
  test('an indexed frame address above a decided gap declines', () => {
    const r5 =
      'r5:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r3, #0\n\tadd\tr2, r2, sp\n\tbl\tg3\n' +
      '\tldr\tr1, .L3\n\tmov\tr2, sp\n\tadd\tr0, r2, r4\n\tldrb\tr0, [r0]\n\tstrb\tr0, [r1]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgb\n';
    expect(() => decompile('r5', r5, ARMV4T_AGBCC)).toThrow(/r2 holds a value and r0 holds none/);
  });

  // CONTROLS for the trim's question: it asks only of the registers it cuts that are FRESH. The
  // return register holds the callee's result after a call, which is no setup (sa3's
  // `ClearCameraStruct`: `mov r0, sp / bl CpuSet / bl sub_80026BC`); and a register a path reaches
  // the call with a call since its last write is the trim's proof, not a hole (sa3's `sub_805DADC`,
  // `mov r3, sp` left behind an optional call). Asking every cut register falsely declines both.
  test('a result over the captured return register, and an unfresh capture, do not decline', () => {
    const ccs =
      'ccs:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, #0x0\n\tstr\tr0, [sp]\n\tldr\tr1, .L5\n' +
      '\tldr\tr2, .L5+0x4\n\tmov\tr0, sp\n\tbl\tCpuSet\n\tbl\tsub_80026BC\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n' +
      '\tbx\tr0\n.L6:\n\t.align\t2, 0\n.L5:\n\t.word\tgCamera\n\t.word\t0x500001b\n';
    expect(decompile('ccs', ccs, ARMV4T_AGBCC).source).toContain('    sub_80026BC();\n');
    const unfresh =
      'unfresh:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r0, #0\n\tmov\tr3, sp\n\tstrh\tr1, [r3]\n\tmov\tr2, #0x2\n' +
      '\tcmp\tr1, #0\n\tbeq\t.L2\n\tadd\tr0, r4, #0\n\tmov\tr3, #0x3\n\tbl\tTransform\n.L2:\n\tadd\tr0, r4, #0\n\tbl\tUpdate\n' +
      '\tmov\tr0, sp\n\tldrh\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('unfresh', unfresh, ARMV4T_AGBCC).source).toContain('Update(a0);\n');
  });

  // …and two indexed addresses are not the same one: a pass of `&buf[j]` in r0 does not excuse
  // leaving `&buf[i]` out in r2. (r3, read for `&buf[j]`, sits past the decided gap at r1 unproven,
  // so the gap refuses before the audit asks.)
  test('an indexed frame address passed does not excuse another, passed or left out', () => {
    const two =
      'two:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r2, sp\n\tadd\tr0, r3, sp\n\tbl\tg3\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('two', two, ARMV4T_AGBCC)).toThrow(/r2 holds a value and r1 holds none/);
  });
});
