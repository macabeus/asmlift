// Regression fixtures — the extensible registry the regression suite iterates over.
//
// Each entry is ONE assembly function pinned end-to-end: reference C → toolchain asm →
// asmlift decompile → recompile → REAL objdiff score. Adding coverage for a new function
// is a one-liner: append a fixture here. Nothing else changes.
//
// `expectSource` pins the emitted C byte-for-byte, so a regression that silently changes
// the generated text (even while still matching) is caught. `expectScore`/`expectMatch`
// pin the objdiff outcome. Golden values are captured from a real toolchain run — never
// hand-guessed. When a deliberate improvement changes the emitted text, re-capture the
// golden `expectSource` (see packages/cli/CONTRIBUTION.md › Tests) rather than loosening the assertion.
import { MUL_CONST_PATTERNS, type RewritePattern, SDIV_POW2_2 } from '@asmlift/core/pattern/engine';
import type { Prototypes } from '@asmlift/core/proto';

/** which toolchain compiles `referenceC` and scores the recompile (default agbcc) */
export type FixtureToolchain = 'agbcc' | 'ido' | 'mwcc';

export interface DecompFixture {
  /** the symbol / function name */
  symbol: string;
  /** reference C compiled with the fixture's toolchain to produce BOTH the scoring target
   *  and asmlift's input */
  referenceC: string;
  /** toolchain axis (default "agbcc"; "mwcc" fixtures are Docker-gated) */
  toolchain?: FixtureToolchain;
  /** idiom patterns for the lift. Omitted = DEFAULT_IDIOM_PATTERNS — decompile()'s own
   *  default and the benchmark path. Pass `[]` to pin the naive no-idiom baseline. */
  patterns?: RewritePattern[];
  /** function prototypes keyed by symbol (as a project's headers would provide): a callee's
   *  `params` drives `bl` arg recovery; the fixture's own entry carries its `returnsVoid`. */
  prototypes?: Prototypes;
  /** golden emitted C — asserted byte-for-byte when present */
  expectSource?: string;
  /** expected objdiff score (0 = byte-exact). Default 0. */
  expectScore?: number;
  /** expected byte-exact match. Default true. */
  expectMatch?: boolean;
  /** expected number of pattern rewrites that fired. Asserted when present. */
  expectPatternHits?: number;
  /** short human tag shown in the test name and as coverage documentation */
  note: string;
}

export const FIXTURES: DecompFixture[] = [
  {
    symbol: 'clamp0',
    referenceC: 'int clamp0(int x){ if (x < 0) return 0; return x; }',
    expectSource: 's32 clamp0(s32 a0) {\n    if (a0 < 0) a0 = 0;\n    return a0;\n}\n',
    note: 'branch / single-if diamond join',
  },
  {
    symbol: 'half',
    referenceC: 'int half(int x){ return x / 2; }',
    patterns: [SDIV_POW2_2],
    expectPatternHits: 1,
    expectSource: 's32 half(s32 a0) {\n    return a0 / 2;\n}\n',
    note: 'signed /2 idiom (the report function)',
  },
  {
    symbol: 'sum_to',
    referenceC: 'int sum_to(int n){ int s = 0; int i; for (i = 0; i < n; i++) s += i; return s; }',
    expectSource:
      's32 sum_to(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n' +
      '    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n        v1 = v1 + v0;\n    }\n    return v1;\n}\n',
    note: 'for-loop — Braun back-edge sealing + while recovery, re-spelled `for`',
  },
  {
    symbol: 'fact',
    referenceC: 'int fact(int n){ int r = 1; while (n > 1) { r *= n; n--; } return r; }',
    expectSource:
      's32 fact(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v1 = a0;\n    v0 = 1;\n' +
      '    while (v1 > 1) {\n        v0 = v0 * v1;\n        v1 = v1 - 1;\n    }\n    return v0;\n}\n',
    note: 'while-loop with a loop-carried accumulator',
  },
  {
    // agbcc emits `push {r4, r5, lr}` / `pop {r4, r5}; pop {r1}; bx r1` here — a real stack
    // frame saving callee-saved registers under register pressure. asmlift treats the
    // prologue/epilogue as transparent (they save and restore the same regs) and lifts the
    // arithmetic normally. This also guards ABI-ordered parameter naming: agbcc copies the
    // callee-saved arg into r4 before touching r0, so params are read out of a0..a3 order.
    symbol: 'four',
    referenceC: 'int four(int a, int b, int c, int d){ return a*d + b*c + c*d + a*b; }',
    expectSource:
      's32 four(s32 a0, s32 a1, s32 a2, s32 a3) {\n' + '    return a0 * a3 + a1 * a2 + a2 * a3 + a1 * a0;\n}\n',
    note: 'stack frame — straight-line, callee-saved register pressure (push {r4,r5,lr})',
  },
  {
    // A stack frame (`push {r4, lr}`) combined with a loop: the argument `a` is copied into
    // callee-saved r4 so it survives the loop, then used in the post-loop `s*a + b`. Exercises
    // frame transparency + ABI param ordering + loop recovery + a post-loop return expression.
    symbol: 'surv',
    referenceC: 'int surv(int n, int a, int b){ int s = 0, i; for (i = 0; i < n; i++) s += i; return s*a + b; }',
    expectSource:
      's32 surv(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n' +
      '    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n        v1 = v1 + v0;\n    }\n    return v1 * a1 + a2;\n}\n',
    note: 'stack frame — callee-saved survivor across a loop (push {r4,lr})',
  },
  {
    // A `bl g` with the argument already in r0 and the result reused: `g(x) + 1`. The call
    // result inlines where it is used, matching agbcc's `bl g; add r0, r0, #1`.
    symbol: 'callone',
    referenceC: 'int g(int); int callone(int x){ return g(x) + 1; }',
    prototypes: { g: { params: 1 } },
    expectSource: 's32 callone(s32 a0) {\n    return g(a0) + 1;\n}\n',
    note: 'call — one arg, result reused',
  },
  {
    // A three-argument call, one argument a constant set up in r2 (`mov r2, #7`). Exercises
    // multi-argument recovery from the signature map.
    symbol: 'calltwo',
    referenceC: 'int add3(int,int,int); int calltwo(int a,int b){ return add3(a,b,7); }',
    prototypes: { add3: { params: 3 } },
    expectSource: 's32 calltwo(s32 a0, s32 a1) {\n    return add3(a0, a1, 7);\n}\n',
    note: 'call — three args incl. a constant',
  },
  {
    // The argument `y` sits in r1 (a caller-saved argument register) but is NOT passed to
    // `g`; agbcc copies it to callee-saved r4 so it survives the call, then adds it after.
    // The copy-aliasing keeps `y` live across the call, so `g` is recovered as one-argument.
    symbol: 'callsurv',
    referenceC: 'int g(int); int callsurv(int x,int y){ return g(x) + y; }',
    prototypes: { g: { params: 1 } },
    expectSource: 's32 callsurv(s32 a0, s32 a1) {\n    return g(a0) + a1;\n}\n',
    note: 'call — a parameter preserved across the call, not passed to it',
  },
  {
    // Two sequential calls, both results live at once (`g(x) + g(x+1)`). Each call result
    // inlines into the final sum; agbcc saves the first result in r5 across the second call.
    symbol: 'calltwice',
    referenceC: 'int g(int); int calltwice(int x){ return g(x) + g(x+1); }',
    prototypes: { g: { params: 1 } },
    expectSource: 's32 calltwice(s32 a0) {\n    return g(a0) + g(a0 + 1);\n}\n',
    note: 'call — two sequential calls, both results live',
  },
  {
    // A call inside a loop body: `for (i…) s += g(i)`. Combines call recovery with loop
    // recovery — the call inlines into the loop-carried accumulator update.
    symbol: 'callloop',
    referenceC: 'int g(int); int callloop(int n){ int s=0,i; for(i=0;i<n;i++) s+=g(i); return s; }',
    prototypes: { g: { params: 1 } },
    expectSource:
      's32 callloop(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n' +
      '    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n        v1 = v1 + g(v0);\n    }\n    return v1;\n}\n',
    note: 'call — inside a loop, folded into the accumulator update',
  },
  {
    symbol: 'baseacrosscalls',
    referenceC: 'void g(int); void baseacrosscalls(void){ int *p=(int*)0x30056d0; g(p[1]); g(p[0]); g(p[2]); }',
    prototypes: { baseacrosscalls: { returnsVoid: true }, g: { params: 1 } },
    expectSource:
      'void baseacrosscalls(void) {\n    s32 * v0;\n    v0 = (s32 *)50353872;\n' +
      '    g(v0[1]);\n    g(*v0);\n    g(v0[2]);\n    return;\n}\n',
    note: 'const base live ACROSS calls — materialized into a local (the callee-saved register the compiler keeps it in), not re-inlined per use. A const NOT live across a call (small init immediate) must stay inlined — see sum_to.',
  },
  {
    // A pointer dereference: `ldr r0, [r0]`. Type recovery marks the base as `s32 *` from
    // the word load, and the zero-offset access prints as `*a0`.
    symbol: 'deref',
    referenceC: 'int deref(int *p){ return *p; }',
    expectSource: 's32 deref(s32 * a0) {\n    return *a0;\n}\n',
    note: 'memory — pointer load (*p)',
  },
  {
    // A struct-field / array load at a non-zero word offset: `ldr r0, [r0, #0x8]` → `a0[2]`.
    symbol: 'field',
    referenceC: 'struct S{ int a; int b; int c; }; int field(struct S *s){ return s->c; }',
    expectSource: 's32 field(s32 * a0) {\n    return a0[2];\n}\n',
    note: 'memory — word load at offset 8 (a0[2])',
  },
  {
    // A byte load: `ldrb r0, [r0, #0x2]`. The 1-byte width types the base `u8 *`, so the
    // offset scales by 1 → `a0[2]`.
    symbol: 'byte',
    referenceC: 'int byte(unsigned char *p){ return p[2]; }',
    expectSource: 's32 byte(u8 * a0) {\n    return a0[2];\n}\n',
    note: 'memory — byte load, width-scaled offset (u8 *)',
  },
  {
    // A pointer store in a void function: `str r1, [r0]` → `*a0 = a1;`. Exercises the
    // side-effecting-statement path and void return suppression.
    symbol: 'setp',
    referenceC: 'void setp(int *p, int v){ *p = v; }',
    prototypes: { setp: { returnsVoid: true } },
    expectSource: 'void setp(s32 * a0, s32 a1) {\n    *a0 = a1;\n    return;\n}\n',
    note: 'memory — pointer store, void function',
  },
  {
    // A field store at a word offset: `str r1, [r0, #0x4]` → `a0[1] = a1;`.
    symbol: 'fieldw',
    referenceC: 'struct S{ int a; int b; }; void fieldw(struct S *s, int v){ s->b = v; }',
    prototypes: { fieldw: { returnsVoid: true } },
    expectSource: 'void fieldw(s32 * a0, s32 a1) {\n    a0[1] = a1;\n    return;\n}\n',
    note: 'memory — word store at offset 4 (a0[1])',
  },
  {
    // Read-modify-write: two loads, an add, a store (`s->a += s->b`). The loads inline into
    // the store's value in program order → `*a0 = *a0 + a0[1];`.
    symbol: 'rmw',
    referenceC: 'struct S{ int a; int b; }; void rmw(struct S *s){ s->a += s->b; }',
    prototypes: { rmw: { returnsVoid: true } },
    expectSource: 'void rmw(s32 * a0) {\n    *a0 = *a0 + a0[1];\n    return;\n}\n',
    note: 'memory — read-modify-write (two loads + store)',
  },

  // ── Operator-family coverage ──────────────────────────────────────────────────────────
  // Without these rows, a mutation flipping `icmp_sle`/`icmp_eq`/`icmp_ne` or any bitwise/shift
  // op ships GREEN. Each row pins one operator so such a mutation fails loudly. The comparison
  // rows mirror `clamp0`'s if-assign-fallthrough shape (the one that structures cleanly); the
  // bitwise/shift rows are straight-line binary. All goldens captured from real toolchain runs.
  {
    symbol: 'le0',
    referenceC: 'int le0(int x){ if (x <= 0) return 0; return x; }',
    expectSource: 's32 le0(s32 a0) {\n    if (a0 <= 0) a0 = 0;\n    return a0;\n}\n',
    note: 'compare — signed <= (icmp_sle)',
  },
  {
    symbol: 'ge0',
    referenceC: 'int ge0(int x){ if (x >= 0) return 0; return x; }',
    expectSource: 's32 ge0(s32 a0) {\n    if (a0 >= 0) a0 = 0;\n    return a0;\n}\n',
    note: 'compare — signed >= (icmp_sge)',
  },
  {
    symbol: 'eqset',
    referenceC: 'int eqset(int x){ if (x == 0) return 5; return x; }',
    expectSource: 's32 eqset(s32 a0) {\n    if (a0 == 0) a0 = 5;\n    return a0;\n}\n',
    note: 'compare — equality (icmp_eq)',
  },
  {
    // NEGATIVE fixture. `!=` does not reduce to the clean if-assign form: asmlift emits an
    // if/else with a temp, which is not how agbcc lowered it → score 5, no byte-match. This
    // documents a real structuring gap AND guards the scorer's `match:false` reporting path.
    // It still exercises the `icmp_ne` lowering: a mutation flipping it changes expectSource.
    symbol: 'neset',
    referenceC: 'int neset(int x){ if (x != 0) return 5; return x; }',
    expectSource:
      's32 neset(s32 a0) {\n    s32 v0;\n    if (a0 != 0) {\n        v0 = 5;\n' +
      '    } else {\n        v0 = 0;\n    }\n    return v0;\n}\n',
    expectScore: 5,
    expectMatch: false,
    note: 'compare — inequality (icmp_ne): NEGATIVE, documents the if/else-with-temp gap',
  },
  {
    symbol: 'orf',
    referenceC: 'int orf(int a,int b){ return a | b; }',
    expectSource: 's32 orf(s32 a0, s32 a1) {\n    return a0 | a1;\n}\n',
    note: 'bitwise — or',
  },
  {
    symbol: 'andf',
    referenceC: 'int andf(int a,int b){ return a & b; }',
    expectSource: 's32 andf(s32 a0, s32 a1) {\n    return a0 & a1;\n}\n',
    note: 'bitwise — and',
  },
  {
    symbol: 'xorf',
    referenceC: 'int xorf(int a,int b){ return a ^ b; }',
    expectSource: 's32 xorf(s32 a0, s32 a1) {\n    return a0 ^ a1;\n}\n',
    note: 'bitwise — xor',
  },
  {
    symbol: 'shl3',
    referenceC: 'int shl3(int a){ return a << 3; }',
    expectSource: 's32 shl3(s32 a0) {\n    return a0 << 3;\n}\n',
    note: 'shift — left by immediate (shl)',
  },
  {
    symbol: 'asr2',
    referenceC: 'int asr2(int a){ return a >> 2; }',
    expectSource: 's32 asr2(s32 a0) {\n    return a0 >> 2;\n}\n',
    note: 'shift — arithmetic right by immediate (ashr)',
  },

  // ── Multiply-by-constant idioms (DIVMUL) ──────────────────────────────────────────────
  // agbcc strength-reduces `x * C` for small C into a shift + one add/sub (a shift chain beats a
  // general multiply). asmlift folds the chain back to `x * C` via MUL_CONST_PATTERNS — a computed
  // replacement multiplier (`2^k±1`, `c·2^k`). Re-emitting `x * C` lets agbcc regenerate the exact
  // chain byte-for-byte. Each row pins one arm of the widening.
  {
    symbol: 'mul3',
    referenceC: 'int mul3(int a){ return a * 3; }',
    patterns: MUL_CONST_PATTERNS,
    expectPatternHits: 1,
    expectSource: 's32 mul3(s32 a0) {\n    return a0 * 3;\n}\n',
    note: 'multiply — x*(2^1+1) via (x<<1)+x (mul-shift-add)',
  },
  {
    symbol: 'mul7',
    referenceC: 'int mul7(int a){ return a * 7; }',
    patterns: MUL_CONST_PATTERNS,
    expectPatternHits: 1,
    expectSource: 's32 mul7(s32 a0) {\n    return a0 * 7;\n}\n',
    note: 'multiply — x*(2^3-1) via (x<<3)-x (mul-shift-sub, non-commutative)',
  },
  {
    symbol: 'mul9',
    referenceC: 'int mul9(int a){ return a * 9; }',
    patterns: MUL_CONST_PATTERNS,
    expectPatternHits: 1,
    expectSource: 's32 mul9(s32 a0) {\n    return a0 * 9;\n}\n',
    note: 'multiply — x*(2^3+1) via (x<<3)+x (mul-shift-add)',
  },
  {
    // agbcc emits `x*6` = `(x*3)<<1` — a two-level chain. mul-shift-sub folds the inner `x*3`
    // first, then mul-shift-scale binds that multiplier `c=3` off its const operand and the outer
    // shift `k=1` and folds to a single `x * (3·2) = x * 6`. Two rewrites fire (inner + composite).
    symbol: 'mul6',
    referenceC: 'int mul6(int a){ return a * 6; }',
    patterns: MUL_CONST_PATTERNS,
    expectPatternHits: 2,
    expectSource: 's32 mul6(s32 a0) {\n    return a0 * 6;\n}\n',
    note: 'multiply — composite x*(c·2^k): (x*3)<<1 (mul-shift-scale over mul-shift-sub)',
  },
  {
    // agbcc INVERTS a simple `if`'s branch, so `le0`/`ge0`/`eqset` above actually exercise
    // icmp_sgt/icmp_slt/icmp_ne — leaving `icmp_sle` and `icmp_eq` with NO producing fixture.
    // A loop keeps the DIRECT comparison, so this `<=` loop condition is the only fixture that
    // emits `icmp_sle`.
    symbol: 'leloop',
    referenceC: 'int leloop(int n){ int s=0,i; for(i=0;i<=n;i++) s+=i; return s; }',
    expectSource:
      's32 leloop(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n' +
      '    for (v0 = 0; v0 <= a0; v0 = v0 + 1) {\n        v1 = v1 + v0;\n    }\n    return v1;\n}\n',
    note: 'compare — signed <= in a loop condition (icmp_sle, the only producer)',
  },
  {
    // `return x != 0;` lowers to an inverted set-equal, so its IR carries `icmp_eq` — the only
    // fixture that produces it (a simple `==` if inverts to icmp_ne instead).
    symbol: 'neret',
    referenceC: 'int neret(int x){ return x != 0; }',
    expectSource: 's32 neret(s32 a0) {\n    if (a0 != 0) a0 = 1;\n    return a0;\n}\n',
    note: 'compare — equality (icmp_eq, the only producer)',
  },

  // ── Fixed silent-miscompile bugs, regression-guarded ─────────────────────────────────
  // Each of these once emitted confidently-wrong C with no error: unary ops silently dropped,
  // register shift → `<< NaN`, void call deleted. The "Was …" notes record the wrong output.
  {
    // Was `return a0;` — the frontend had no `neg`/`rsb #0` decode, so `-x` vanished.
    symbol: 'negf',
    referenceC: 'int negf(int x){ return -x; }',
    expectSource: 's32 negf(s32 a0) {\n    return -a0;\n}\n',
    note: 'unary — arithmetic negation (neg → -x)',
  },
  {
    // Was `return a0;` — no `mvn` decode, so `~x` vanished.
    symbol: 'notf',
    referenceC: 'int notf(int x){ return ~x; }',
    expectSource: 's32 notf(s32 a0) {\n    return ~a0;\n}\n',
    note: 'unary — bitwise complement (mvn → ~x)',
  },
  {
    // Was `return a0 << NaN;` (uncompilable) — a register-amount shift `lsl rD,rS,rN` was
    // mis-decoded as an immediate. Now a two-operand shl.
    symbol: 'shlf',
    referenceC: 'int shlf(int a,int b){ return a << b; }',
    expectSource: 's32 shlf(s32 a0, s32 a1) {\n    return a0 << a1;\n}\n',
    note: 'shift — register shift amount (lsl rD,rS,rN)',
  },
  {
    // Was `void callvoid(s32 a0) { return; }` — the call vanished: the suppressed void `ret`
    // marked r0 used, so `sideEffects()` skipped the dead call. Now emitted as a statement.
    symbol: 'callvoid',
    referenceC: 'void v(int); void callvoid(int x){ v(x); }',
    prototypes: { v: { params: 1 }, callvoid: { returnsVoid: true } },
    expectSource: 'void callvoid(s32 a0) {\n    v(a0);\n    return;\n}\n',
    note: 'call — discarded void call is a statement, not dropped',
  },
  {
    // Was `s32 divv(void) { return __divsi3(); }` — the soft-division helper `bl __divsi3` as
    // an opaque call has no signature (args lost, uncompilable). raise/softdiv.ts recognizes and
    // lowers it to the `sdiv` op so recovery + structuring print `a / b`, recompiling to the same
    // helper call. Register-divide forms (signed/unsigned, div + mod):
    symbol: 'divv',
    referenceC: 'int divv(int a,int b){ return a / b; }',
    expectSource: 's32 divv(s32 a0, s32 a1) {\n    return a0 / a1;\n}\n',
    note: 'soft-div — signed __divsi3 → a / b (S1)',
  },
  {
    symbol: 'modv',
    referenceC: 'int modv(int a,int b){ return a % b; }',
    expectSource: 's32 modv(s32 a0, s32 a1) {\n    return a0 % a1;\n}\n',
    note: 'soft-div — signed __modsi3 → a % b (S1)',
  },
  {
    symbol: 'udivv',
    referenceC: 'unsigned udivv(unsigned a,unsigned b){ return a / b; }',
    expectSource: 'u32 udivv(u32 a0, u32 a1) {\n    return a0 / a1;\n}\n',
    note: 'soft-div — unsigned __udivsi3 → a / b (S1)',
  },
  {
    // Constant divisor: agbcc does not strength-reduce at -O2, it calls `__divsi3(a, 7)`. The
    // recognizer folds to `sdiv a, 7` (2-operand-with-const), printed as `a / 7`.
    symbol: 'divc',
    referenceC: 'int divc(int a){ return a / 7; }',
    expectSource: 's32 divc(s32 a0) {\n    return a0 / 7;\n}\n',
    note: 'soft-div — constant divisor __divsi3(a,7) → a / 7 (S1)',
  },

  // ── Default idiom bundle (no `patterns` key = the benchmark path) ─────────────────────
  // These pin that the DEFAULT bundle fires: `decompile()` with no opts.patterns applies
  // DEFAULT_IDIOM_PATTERNS, each `{compilers}`-gated so one global bundle self-selects per
  // target. A revert to default-off breaks the `expectPatternHits` here. (The `patterns: []`
  // opt-out baseline is pinned by matching/m2.test.ts.)
  {
    // agbcc has no hardware divide → `x/2` lowers to `lsr#31;add;asr#1`; without the fold the
    // backend prints `asr` over an s32 and recompiles wrong.
    symbol: 'div2',
    referenceC: 'int div2(int a){ return a / 2; }',
    expectPatternHits: 1,
    expectSource: 's32 div2(s32 a0) {\n    return a0 / 2;\n}\n',
    note: 'default bundle — sdiv-pow2 folds x / 2 (agbcc)',
  },
  {
    // `x*10` = `(x*5)<<1` — a two-level shift chain (scale over base add).
    symbol: 'mul10',
    referenceC: 'int mul10(int a){ return a * 10; }',
    expectPatternHits: 2,
    expectSource: 's32 mul10(s32 a0) {\n    return a0 * 10;\n}\n',
    note: 'default bundle — mul-const folds x * 10 (agbcc)',
  },
  {
    // IDO has hardware divide but still strength-reduces small constant multiplies.
    symbol: 'mul10',
    referenceC: 'int mul10(int a){ return a * 10; }',
    toolchain: 'ido',
    expectPatternHits: 2,
    expectSource: 's32 mul10(s32 a0) {\n    return a0 * 10;\n}\n',
    note: 'default bundle — mul-const folds x * 10 (IDO)',
  },

  // ── Byte/half cast (extension) idioms, agbcc, default bundle (S4) ─────────────────────
  // agbcc (ARMv4T, no byte/half move) lowers a narrowing cast to a shift pair
  // `x << (32-w) >> (32-w)` — LOGICAL shr for unsigned, ARITHMETIC for signed. A naive lift
  // prints `a0 << 24 >> 24`; C's `>>` over the s32 value is arithmetic, so the unsigned
  // (zero-extend) cases miscompile with `asr` where the target has `lsr`. The cast idioms
  // fold the pair to a `zext`/`sext` op printed `(u8)a0` &c., byte-exact on recompile.
  {
    symbol: 'tou8',
    referenceC: 'int tou8(int x){ return (unsigned char)x; }',
    expectPatternHits: 1,
    expectSource: 's32 tou8(s32 a0) {\n    return (u8)a0;\n}\n',
    note: 'cast idiom — zext byte (u8)',
  },
  {
    symbol: 'tos8',
    referenceC: 'int tos8(int x){ return (signed char)x; }',
    expectPatternHits: 1,
    expectSource: 's32 tos8(s32 a0) {\n    return (s8)a0;\n}\n',
    note: 'cast idiom — sext byte (s8)',
  },
  {
    symbol: 'tou16',
    referenceC: 'int tou16(int x){ return (unsigned short)x; }',
    expectPatternHits: 1,
    expectSource: 's32 tou16(s32 a0) {\n    return (u16)a0;\n}\n',
    note: 'cast idiom — zext half (u16)',
  },
  {
    symbol: 'tos16',
    referenceC: 'int tos16(int x){ return (short)x; }',
    expectPatternHits: 1,
    expectSource: 's32 tos16(s32 a0) {\n    return (s16)a0;\n}\n',
    note: 'cast idiom — sext half (s16)',
  },

  // ── Thumb unsigned conditional branches (T2) ──────────────────────────────────────────
  // `bhi`/`bls`/`bcc`/`bcs` must survive as real terminators: if the frontend drops one, the
  // boolean CFG collapses and the function silently miscompiles to a constant `return`. The
  // goldens pin both arms (`v0 = 0` / `v0 = 1`) and the unsigned compare sense ((u8) / u32).
  // Deliberately NOT byte-exact yet — the boolean-diamond shape misses; the pinned score
  // flips to 0 when boolean-value recovery covers it.
  {
    symbol: 'ult5',
    referenceC: 'int ult5(unsigned char x){ return x < 5; }',
    expectPatternHits: 1,
    expectSource:
      's32 ult5(s32 a0) {\n    s32 v0;\n    if ((u8)a0 > 4) {\n        v0 = 0;\n' +
      '    } else {\n        v0 = 1;\n    }\n    return v0;\n}\n',
    expectMatch: false,
    expectScore: 3,
    note: 'thumb `bhi` survives — unsigned byte compare, both arms (NEGATIVE: near-miss)',
  },
  {
    symbol: 'ugt',
    referenceC: 'int ugt(unsigned a, unsigned b){ return a > b; }',
    expectSource:
      's32 ugt(u32 a0, u32 a1) {\n    s32 v0;\n    if (a0 <= a1) {\n        v0 = 0;\n' +
      '    } else {\n        v0 = 1;\n    }\n    return v0;\n}\n',
    expectMatch: false,
    expectScore: 3,
    note: 'thumb unsigned `>` survives — u32-typed compare, both arms (NEGATIVE: near-miss)',
  },

  // ── MIPS (IDO) vertical slice — the second ISA through the SAME pipeline ──────────────
  // Proves the Frontend seam is a real plug-in; the delay-slot return is the one
  // MIPS-specific wrinkle exercised here. Straight-line integer functions ending in `jr ra`.
  {
    symbol: 'add1',
    referenceC: 'int add1(int x){ return x + 1; }',
    toolchain: 'ido',
    expectSource: 's32 add1(s32 a0) {\n    return a0 + 1;\n}\n',
    note: 'MIPS slice — immediate add + delay-slot return',
  },
  {
    symbol: 'addab',
    referenceC: 'int addab(int a,int b){ return a + b; }',
    toolchain: 'ido',
    expectSource: 's32 addab(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    note: 'MIPS slice — register add',
  },
  {
    symbol: 'orab',
    referenceC: 'int orab(int a,int b){ return a | b; }',
    toolchain: 'ido',
    expectSource: 's32 orab(s32 a0, s32 a1) {\n    return a0 | a1;\n}\n',
    note: 'MIPS slice — bitwise or',
  },
  {
    symbol: 'shl3',
    referenceC: 'int shl3(int a){ return a << 3; }',
    toolchain: 'ido',
    expectSource: 's32 shl3(s32 a0) {\n    return a0 << 3;\n}\n',
    note: 'MIPS slice — shift-left immediate',
  },
  {
    // Variable-amount shifts (`sllv`/`srav` — VALUE then AMOUNT). Guards against operand
    // transposition lifting `a >> b` as `b >> a` (a silent miscompile).
    symbol: 'shrsv',
    referenceC: 'int shrsv(int a,int b){ return a >> b; }',
    toolchain: 'ido',
    expectSource: 's32 shrsv(s32 a0, s32 a1) {\n    return a0 >> a1;\n}\n',
    note: 'MIPS slice — srav operand order (a >> b, not b >> a)',
  },
  {
    symbol: 'shlv',
    referenceC: 'int shlv(int a,int b){ return a << b; }',
    toolchain: 'ido',
    expectSource: 's32 shlv(s32 a0, s32 a1) {\n    return a0 << a1;\n}\n',
    note: 'MIPS slice — sllv operand order',
  },
  {
    symbol: 'bitat',
    referenceC: 'int bitat(int a,int b){ return (a >> b) & 1; }',
    toolchain: 'ido',
    expectSource: 's32 bitat(s32 a0, s32 a1) {\n    return a0 >> a1 & 1;\n}\n',
    note: 'MIPS slice — shift + mask compose',
  },
  {
    symbol: 'negf',
    referenceC: 'int negf(int x){ return -x; }',
    toolchain: 'ido',
    expectSource: 's32 negf(s32 a0) {\n    return -a0;\n}\n',
    note: 'MIPS slice — negate (subu from $zero)',
  },
  {
    symbol: 'notf',
    referenceC: 'int notf(int x){ return ~x; }',
    toolchain: 'ido',
    expectSource: 's32 notf(s32 a0) {\n    return ~a0;\n}\n',
    note: 'MIPS slice — bitwise not (nor)',
  },

  // ── 32-bit constant materialisation (F-CONST) ─────────────────────────────────────────
  // A RISC target builds a 32-bit literal as a high-half load (`lui`/`lis`) + low-half
  // `ori`/`addiu`; `raise/const.ts` folds the const/const pair into ONE literal. The goldens
  // pin the single folded literal (no `hi << 16 | lo` expression), and the byte-exact score
  // pins that it recompiles to the exact original pair.
  {
    symbol: 'bigand',
    referenceC: 'unsigned bigand(unsigned x){ return x & 0x12345678u; }',
    toolchain: 'ido',
    expectSource: 's32 bigand(s32 a0) {\n    return a0 & 305419896;\n}\n',
    note: 'const-materialise — lui;ori under & (MIPS)',
  },
  {
    symbol: 'bigadd',
    referenceC: 'int bigadd(int x){ return x + 0x12345678; }',
    toolchain: 'ido',
    expectSource: 's32 bigadd(s32 a0) {\n    return a0 + 305419896;\n}\n',
    note: 'const-materialise — lui;addiu under + (MIPS)',
  },
  {
    symbol: 'retbig',
    referenceC: 'unsigned retbig(void){ return 0xDEADBEEFu; }',
    toolchain: 'ido',
    expectSource: 's32 retbig(void) {\n    return -559038737;\n}\n',
    note: 'const-materialise — bare 0xDEADBEEF literal (as s32) (MIPS)',
  },
  {
    symbol: 'pbigand',
    referenceC: 'unsigned pbigand(unsigned x){ return x & 0x12345678u; }',
    toolchain: 'mwcc',
    expectSource: 's32 pbigand(s32 a0) {\n    return a0 & 305419896;\n}\n',
    note: 'const-materialise — lis;ori under & (PPC)',
  },
];
