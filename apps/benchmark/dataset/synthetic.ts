// Tier A — synthetic dataset. Functions I author to exercise COMMON decompilation features with
// known ground truth, spread across the four toolchains. Deliberately breadth-first over the idioms
// that dominate real game code (arithmetic, bitwise, compare/logic, width casts, memory, structs,
// arrays, loops, calls) rather than exotic constructs — the anti-overfitting goal.
//
// `toolchains` lists which toolchains to run each function on. MIPS-IDO is steered away from calls
// (its PIC codegen makes external calls unfriendly to both decompilers).
// C++ runs on mwcc_242_81 only (the `.cp` frontend). `ctx` is the m2c --context (prototypes only — no
// struct layouts, so both decompilers must RECOVER structure); `proto` feeds asmlift the same info.
import type { Prototypes } from '@asmlift/core/proto';

import type { ToolchainId } from '../src/toolchains';

export interface SynthSpec {
  sym: string;
  lang?: 'c' | 'c++';
  src: string;
  features: string[];
  toolchains: ToolchainId[];
  ctx?: string; // m2c --context (C declarations)
  proto?: Prototypes; // asmlift prototypes (void-ness / callee params)
  note?: string;
}

const ALL: ToolchainId[] = ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'];
const CALL: ToolchainId[] = ['agbcc', 'gcc2.7.2kmc', 'mwcc_242_81']; // IDO PIC-unfriendly for calls

export const SYNTHETIC: SynthSpec[] = [
  // ── arithmetic ────────────────────────────────────────────────────────────────────────
  { sym: 'add', src: 'int add(int a,int b){ return a+b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'sub', src: 'int sub(int a,int b){ return a-b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'mul', src: 'int mul(int a,int b){ return a*b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'mulc', src: 'int mulc(int a){ return a*10; }', features: ['arithmetic'], toolchains: ALL },
  {
    sym: 'divc',
    src: 'int divc(int a){ return a/7; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'div2',
    src: 'int div2(int a){ return a/2; }',
    features: ['arithmetic', 'div-pow2', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'udivc',
    src: 'unsigned udivc(unsigned a){ return a/7; }',
    features: ['arithmetic', 'div-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'modc',
    src: 'int modc(int a){ return a%10; }',
    features: ['arithmetic', 'mod-const', 'signed'],
    toolchains: ALL,
  },
  // register-divisor division — exercises the soft-division fold (`bl __divsi3(a,b)` on agbcc)
  // AND the hardware-divide decode on ido/gcc/ppc.
  {
    sym: 'divv',
    src: 'int divv(int a,int b){ return a/b; }',
    features: ['arithmetic', 'div-reg', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'modv',
    src: 'int modv(int a,int b){ return a%b; }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'udivv',
    src: 'unsigned udivv(unsigned a,unsigned b){ return a/b; }',
    features: ['arithmetic', 'div-reg', 'unsigned'],
    toolchains: ALL,
  },
  { sym: 'neg', src: 'int neg(int a){ return -a; }', features: ['arithmetic'], toolchains: ALL },
  {
    sym: 'expr1',
    src: 'int expr1(int a,int b,int c){ return a*b + c - 3; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },

  // ── bitwise ───────────────────────────────────────────────────────────────────────────
  { sym: 'band', src: 'int band(int a,int b){ return a&b; }', features: [], toolchains: ALL },
  { sym: 'bor', src: 'int bor(int a,int b){ return a|b; }', features: [], toolchains: ALL },
  { sym: 'bxor', src: 'int bxor(int a,int b){ return a^b; }', features: [], toolchains: ALL },
  { sym: 'bnot', src: 'int bnot(int a){ return ~a; }', features: [], toolchains: ALL },
  { sym: 'shl', src: 'int shl(int a,int b){ return a<<b; }', features: [], toolchains: ALL },
  {
    sym: 'shru',
    src: 'unsigned shru(unsigned a,int b){ return a>>b; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'shrs',
    src: 'int shrs(int a,int b){ return a>>b; }',
    features: ['signed'],
    toolchains: ALL,
  },
  {
    sym: 'mask8',
    src: 'unsigned mask8(unsigned x){ return x & 0xff; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'bittest',
    src: 'int bittest(int x,int n){ return (x>>n)&1; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'setbit',
    src: 'int setbit(int x,int n){ return x | (1<<n); }',
    features: [],
    toolchains: ALL,
  },

  // ── comparison / logic ──────────────────────────────────────────────────────────────────
  { sym: 'maxi', src: 'int maxi(int a,int b){ return a>b?a:b; }', features: ['compare'], toolchains: ALL },
  { sym: 'mini', src: 'int mini(int a,int b){ return a<b?a:b; }', features: ['compare'], toolchains: ALL },
  {
    sym: 'clamp0',
    src: 'int clamp0(int x){ if(x<0) return 0; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'absi', src: 'int absi(int x){ return x<0?-x:x; }', features: ['compare'], toolchains: ALL },
  {
    sym: 'sign',
    src: 'int sign(int x){ if(x>0)return 1; if(x<0)return -1; return 0; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'iszero', src: 'int iszero(int x){ return x==0; }', features: ['compare', 'bool'], toolchains: ALL },
  {
    sym: 'land',
    src: 'int land(int a,int b){ return a && b; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'lor', src: 'int lor(int a,int b){ return a || b; }', features: ['compare', 'branch'], toolchains: ALL },
  {
    sym: 'inrange',
    src: 'int inrange(int x,int lo,int hi){ return x>=lo && x<=hi; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'clampr',
    src: 'int clampr(int x,int lo,int hi){ if(x<lo)x=lo; if(x>hi)x=hi; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },

  // ── width / casts ───────────────────────────────────────────────────────────────────────
  { sym: 'tou8', src: 'u8 tou8(int x){ return (u8)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'tos8', src: 's8 tos8(int x){ return (s8)x; }', features: ['cast', 'narrow', 'signed'], toolchains: ALL },
  { sym: 'tou16', src: 'u16 tou16(int x){ return (u16)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'sextb', src: 'int sextb(s8 x){ return x; }', features: ['sign-extend'], toolchains: ALL },
  { sym: 'zextb', src: 'int zextb(u8 x){ return x; }', features: ['zero-extend'], toolchains: ALL },

  // ── memory ──────────────────────────────────────────────────────────────────────────────
  { sym: 'deref', src: 'int deref(int *p){ return *p; }', features: ['memory', 'load'], toolchains: ALL },
  {
    sym: 'storep',
    src: 'void storep(int *p,int v){ *p=v; }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void storep(int*,int);',
    proto: { storep: { returnsVoid: true } },
  },
  {
    sym: 'loadoff',
    src: 'int loadoff(int *p){ return p[2]; }',
    features: ['memory', 'load'],
    toolchains: ALL,
  },
  {
    sym: 'aidx',
    src: 'int aidx(int *p,int i){ return p[i]; }',
    features: ['memory', 'array', 'variable-index'],
    toolchains: ALL,
  },
  {
    sym: 'astore',
    src: 'void astore(int *p,int i,int v){ p[i]=v; }',
    features: ['memory', 'array', 'store'],
    toolchains: ALL,
    ctx: 'void astore(int*,int,int);',
    proto: { astore: { returnsVoid: true } },
  },
  {
    sym: 'byteidx',
    src: 'u8 byteidx(u8 *p,int i){ return p[i]; }',
    features: ['memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'ptradd',
    src: 'int *ptradd(int *p,int n){ return p+n; }',
    features: ['memory', 'pointer'],
    toolchains: ALL,
  },

  // ── structs (layout NOT in context — must be recovered) ─────────────────────────────────
  {
    sym: 'sfield',
    src: 'struct S{int a;int b;int c;};\nint sfield(struct S*s){ return s->b; }',
    features: ['struct', 'field'],
    toolchains: ALL,
  },
  {
    sym: 'sstore',
    src: 'struct S{int a;int b;};\nvoid sstore(struct S*s,int v){ s->b=v; }',
    features: ['struct', 'field', 'store'],
    toolchains: ALL,
    ctx: 'struct S; void sstore(struct S*,int);',
    proto: { sstore: { returnsVoid: true } },
  },
  {
    sym: 'smixed',
    src: 'struct P{u8 hp;s16 x;int id;};\nint smixed(struct P*p){ return p->x + p->id; }',
    features: ['struct', 'field', 'mixed-width'],
    toolchains: ALL,
  },

  // ── unions (the same storage read at two widths / in two type domains) ──────────────────
  // A union is only measurable when the SAME bytes are reached through members of different width
  // or domain: that is what a decompiler has to reconstruct, and what asmlift currently declines on
  // ("overlapping fields at offset N — unions not modelled"). A union whose members are never
  // aliased compiles identically to a struct, so it would be unscorable — see `sfield`.
  //
  // The aliasing probes take the union through a POINTER on purpose. As a local it lands in a stack
  // slot on the register-poor targets, and asmlift declines on the stack-frame gap BEFORE it ever
  // sees the overlap — the probe would then measure frames, not unions. `upun` is the exception:
  // punning a float through memory is the whole construct, so its FP store/load is the point.
  {
    sym: 'uhalf',
    src: 'union W{u32 w;u16 h[2];};\nu32 uhalf(union W*u,u32 v){ u->w=v; return u->h[0]+u->h[1]; }',
    features: ['union', 'field', 'array', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'ubyte',
    src: 'union B{u32 w;u8 b[4];};\nu32 ubyte(union B*u,u32 v,int i){ u->w=v; return u->b[i]; }',
    features: ['union', 'field', 'array', 'variable-index', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'upun',
    src: 'union F{float f;u32 u;};\nu32 upun(float x){ union F t; t.f=x; return t.u; }',
    features: ['union', 'field', 'float'],
    toolchains: ALL,
    ctx: 'u32 upun(float);',
  },
  {
    sym: 'utag',
    src: 'struct T{int kind;union{int i;u16 h;u8 b;}v;};\nint utag(struct T*t){ switch(t->kind){case 0:return t->v.i;case 1:return t->v.h;default:return t->v.b;} }',
    features: ['union', 'struct', 'field', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'ustore',
    src: 'union E{s32 a;u16 b[2];};\nvoid ustore(union E*e,int i,s32 v){ e[i].a=v; e[i].b[0]=0; }',
    features: ['union', 'field', 'array', 'store', 'mixed-width'],
    toolchains: ALL,
    ctx: 'union E; void ustore(union E*,int,s32);',
    proto: { ustore: { returnsVoid: true } },
  },

  // ── loops ──────────────────────────────────────────────────────────────────────────────
  {
    sym: 'sumto',
    src: 'int sumto(int n){ int s=0,i; for(i=0;i<n;i++)s+=i; return s; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'countdown',
    src: 'int countdown(int n){ int c=0; while(n>0){c++;n--;} return c; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'arraysum',
    src: 'int arraysum(int *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]; return s; }',
    features: ['memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'strlen1',
    src: 'int strlen1(char *s){ int n=0; while(*s){n++;s++;} return n; }',
    features: ['memory', 'pointer'],
    toolchains: ALL,
  },
  {
    sym: 'memset1',
    src: 'void memset1(u8 *p,int n,u8 v){ int i; for(i=0;i<n;i++)p[i]=v; }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void memset1(u8*,int,u8);',
    proto: { memset1: { returnsVoid: true } },
  },
  {
    sym: 'findfirst',
    src: 'int findfirst(int *a,int n,int t){ int i; for(i=0;i<n;i++) if(a[i]==t) return i; return -1; }',
    features: ['branch', 'memory'],
    toolchains: ALL,
  },

  // ── calls ───────────────────────────────────────────────────────────────────────────────
  {
    sym: 'call1',
    src: 'int helper(int);\nint call1(int x){ return helper(x)+1; }',
    features: [],
    toolchains: CALL,
    ctx: 'int helper(int);',
    proto: { helper: { params: 1 } },
  },
  {
    sym: 'call2',
    src: 'int add3(int,int,int);\nint call2(int a,int b){ return add3(a,b,a+b); }',
    features: ['multi-arg'],
    toolchains: CALL,
    ctx: 'int add3(int,int,int);',
    proto: { add3: { params: 3 } },
  },
  {
    sym: 'voidcall',
    src: 'void sink(int);\nvoid voidcall(int x){ sink(x); }',
    features: [],
    toolchains: CALL,
    ctx: 'void sink(int); void voidcall(int);',
    proto: { sink: { params: 1, returnsVoid: true }, voidcall: { returnsVoid: true } },
  },

  // ── nested control flow ─────────────────────────────────────────────────────────────────
  {
    sym: 'nestedif',
    src: 'int nestedif(int a,int b){ if(a>0){ if(b>0) return a+b; return a; } return 0; }',
    features: ['branch'],
    toolchains: ALL,
  },
  {
    sym: 'loopif',
    src: 'int loopif(int *a,int n){ int s=0,i; for(i=0;i<n;i++){ if(a[i]>0) s+=a[i]; } return s; }',
    features: ['branch', 'memory'],
    toolchains: ALL,
  },

  // ── switch (comparison-tree, sparse, fallthrough, default, and a DENSE jump table) ───────────
  // The small (2–5-case) switches below compile to comparison trees on every toolchain; only a
  // dense contiguous switch (sw_jt) becomes a real jump table. Both regimes are exercised.
  {
    sym: 'sw_ret',
    src: 'int sw_ret(int x){ switch(x){case 0:return 10;case 1:return 20;case 2:return 30;case 3:return 40;default:return -1;} }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'sw_op',
    src: 'int sw_op(int op,int a,int b){ switch(op){case 0:return a+b;case 1:return a-b;case 2:return a*b;case 3:return a&b;default:return 0;} }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'sw_fall',
    src: 'int sw_fall(int x){ int r=0; switch(x){case 3:r++;case 2:r++;case 1:r++;} return r; }',
    features: ['fallthrough'],
    toolchains: ALL,
  },
  {
    sym: 'sw_sparse',
    src: 'int sw_sparse(int x){ switch(x){case 1:return 1;case 10:return 2;case 100:return 3;case 1000:return 4;default:return 0;} }',
    features: ['sparse'],
    toolchains: ALL,
  },
  {
    sym: 'sw_void',
    src: 'void sw_void(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;default:*p=0;} }',
    features: ['memory'],
    toolchains: ALL,
    ctx: 'void sw_void(int,int*);',
    proto: { sw_void: { returnsVoid: true } },
  },
  // Dense 8-case switch → a jump table on every toolchain (agbcc `mov pc` inline table; IDO/KMC
  // `jr` + `.rodata`; mwcc `bctr` + `.data`); MIPS/PPC recovery needs the AsmData side-table.
  {
    sym: 'sw_jt',
    src: 'int sw_jt(int x){ switch(x){case 0:return 3;case 1:return 5;case 2:return 7;case 3:return 9;case 4:return 11;case 5:return 13;case 6:return 15;case 7:return 17;default:return -1;} }',
    features: ['dense'],
    toolchains: ALL,
  },

  // ── merged value chains (several values decided by several arms, joined at one point) ───────
  // What SSA destruction has to get right. Each arm computes the same set of values, so the join
  // takes one block parameter per value and each arm hands them over on its edge — and a parameter
  // and the argument feeding it are one variable only if the structurer gives them one name. It can
  // only ever adopt ONE arm's names; every other arm's values reach the join under names of their
  // own, and each pays a copy. The C the source wrote has none of them, and neither does the
  // compiled code, which allocates all the arms into the same registers.
  //
  // Three values per arm, not one: a single value is coalesced by walking backward along its own
  // edge, which the naming pipeline already did. It takes a chain — a value whose own definition is
  // ANOTHER join, in an arm named after the one the outer join adopted — to leave a copy behind.
  // Loads through a pointer parameter give that shape without a global, which no synthetic row has.
  //
  // mergeif is not mergechain at a smaller size: each arm decides only ONE of the two locals, so
  // the other is live ACROSS the arm that does not write it — the shape the interference rule has
  // to see, rather than two arms that both decide everything.
  //
  // mergeloop is the same shape with the join inside a loop, and coalescing is INERT on it: the
  // naming pipeline already shares every name the arms feed, so no pair is even proposed. That is
  // worth a row precisely because it is the negative — the shape reaches a loop and the pass has
  // nothing to do there, which is not the same claim as a rule refusing it. What `loop-escape`
  // actually costs is visible on `nestedloop`, which this family does not inhabit.
  //
  // WHAT THESE DO NOT COVER, so nobody later reads twelve rows as twelve tests: five decline in the
  // FRONTEND for reasons with nothing to do with merges — MIPS branch-likely (`beql`/`bnezl`), a
  // PPC branch with no reaching `cr0` compare, a branch to a non-block-boundary. Three more exist
  // to be refused. Four rows reach the accept path.
  {
    sym: 'mergechain',
    src:
      'int mergechain(int s, const int *p) {\n' +
      '  int x, y, z;\n' +
      '  switch (s) {\n' +
      '    case 0: x = p[0] > 31 ? 32 : p[0]; y = p[1] > 31 ? 32 : p[1]; z = p[2] > 31 ? 32 : p[2]; break;\n' +
      '    case 1: x = p[3] > 15 ? 16 : p[3]; y = p[4] > 15 ? 16 : p[4]; z = p[5] > 15 ? 16 : p[5]; break;\n' +
      '    default: x = p[6] > 7 ? 8 : p[6]; y = p[7] > 7 ? 8 : p[7]; z = p[8] > 7 ? 8 : p[8]; break;\n' +
      '  }\n' +
      '  return x * 100 + y * 10 + z;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },
  {
    sym: 'mergeif',
    src:
      'int mergeif(int s, const int *p) {\n' +
      '  int x, y;\n' +
      '  x = p[0] > 31 ? 32 : p[0];\n' +
      '  y = p[1] > 31 ? 32 : p[1];\n' +
      '  if (s & 1) { y = p[2] < 0 ? 0 : p[2]; }\n' +
      '  else { x = p[3] < 0 ? 0 : p[3]; }\n' +
      '  return x * 10 + y;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },
  {
    sym: 'mergeloop',
    src:
      'int mergeloop(int n, const int *p) {\n' +
      '  int x = 0, y = 0, i;\n' +
      '  for (i = 0; i < n; i++) {\n' +
      '    if (p[i] & 1) { x = p[i] > 31 ? 32 : p[i]; y = p[i] * 2; }\n' +
      '    else { x = p[i] < 0 ? 0 : p[i]; y = p[i] * 3; }\n' +
      '  }\n' +
      '  return x * 10 + y;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },

  // ── uninitialised locals (a local read on a path that never assigns it) ─────────────────────
  // Every switch above carries a `default`, so until these rows the dataset never asked what
  // happens when one does NOT. The C compiles, and the compiler emits the unassigned path
  // faithfully, so recovery has to be able to SAY "undefined here" — asmlift's IR has no `undef`,
  // and Braun's construction resolves a def-less read to a live-in, which at the entry block is a
  // PARAMETER. WHERE the local lands decides which way that goes, and the two differ sharply:
  //   • a stack slot ⇒ loud. Two guards split it — stored on SOME path (frontend/ssa.ts `finish`)
  //     vs stored on NO path reaching the read (frontend/mips.ts, which still conflates the
  //     second with a 5th+ stack argument). uninit_join and uninit_sw hit one each, on ido7.1.
  //   • a register ⇒ silent: nothing guards it and the read becomes a fabricated extra parameter.
  //     MEASURED, and the two rows disagree, which is why both are here. On uninit_sw:agbcc the
  //     fabrication perturbs codegen and the row is a NONMATCH (`uninit_sw(u32,u32,u32)` for a
  //     two-argument function). On uninit_join:agbcc the invented parameter lands in the register
  //     the local was allocated to anyway, so it byte-MATCHES with an arity the source never had —
  //     a fidelity gap the byte score cannot see, and the reason this row is worth keeping green.
  //
  // WHICH of those you get is decided by register pressure, not by the C, and that is what
  // uninit_spill is for. The first two rows are small enough that agbcc keeps the local in a
  // register, so they reach the slot half on ido7.1 ONLY — and the shared postcondition would
  // then have no row reaching it through the THUMB frontend, which is the path the motivating
  // klonoa function (LoadBGTilemapData, a `switch` with no default whose arms are the only
  // writers of three frame slots) actually takes. uninit_spill keeps ten locals live across a
  // loop so agbcc has to spill, and it reproduces that decline verbatim. Its bulk IS the point:
  // below roughly ten live locals agbcc has the registers to avoid the frame entirely. No calls,
  // deliberately — a store to [sp,#0] that reaches a `bl` is ambiguous with an outgoing stack
  // argument, and the row would decline on THAT instead.
  // Attribution, so nothing here is credited to the wrong gap: of the twelve rows, five turn on
  // this capability — uninit_join:ido7.1, uninit_sw:ido7.1, uninit_sw:agbcc, and both slot halves
  // of uninit_spill (agbcc, ido7.1). The rest decline on branch-likely (gcc2.7.2kmc), a cr0
  // reaching-compare, or r1-as-data (mwcc_242_81) — all pre-existing and unrelated.
  // Of those five, only uninit_spill:agbcc is recovered: the ido7.1 pair declines because that
  // frontend claims no frame partition (its slot keys reach O32's caller-owned argument home area),
  // and uninit_sw:agbcc is the register half, which `undef` does not touch.
  // The first two rows are kept to ≤4 parameters on purpose: at 5+ the O32 reader takes its
  // stack-argument path and would decline for a reason that has nothing to do with initialisation.
  {
    sym: 'uninit_join',
    src: 'int uninit_join(int a){ int r; if(a>0) r=a*2; return r+1; }',
    features: ['uninit-local', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'uninit_sw',
    src: 'int uninit_sw(int k,int a){ int r; switch(k){case 0:r=a;break;case 1:r=a*2;break;case 2:r=a*3;break;case 3:r=a*4;break;} return r+1; }',
    features: ['uninit-local'],
    toolchains: ALL,
  },
  {
    sym: 'uninit_spill',
    src:
      'int uninit_spill(int k,int *p){ int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'array'],
    toolchains: ALL,
  },

  // A LOOP VARIABLE READ AT ITS PRE-UPDATE VALUE. agbcc hoists an induction update above the exit
  // test, so something still wants the variable one iteration back. The structurer treats every
  // such read as a hazard and declines the whole function — correct, because rendering it under
  // the post-update name is an off-by-one-iteration miscompile, but it costs 29 functions across
  // the klonoa/sa3/newlib corpus and no other benchmark row reproduces it.
  //
  // ONE decline message, THREE causes, which is the point of authoring several rows: the message
  // groups them and the fix does not. `preupdate_cond` is the loop CONDITION reading it,
  // `preupdate_exit` is the EXITING EDGE carrying it, and `preupdate_escape` is a body value read
  // after the loop deriving from it. Only the middle one reaches the repair that already exists
  // (`sinkablePreUpdateSlots`, the trailing-pointer sink) and is turned away there by the
  // `arg-is-loop-variable` gate, which is where every real function on this link is refused.
  //
  // DEPTH, and then WHAT THE ARG IS. For 11 of the 12 real EXIT functions that gate is the LAST
  // link, but they do not all need the same thing behind it: the copy is spelled from the arg's
  // NAME, so a computed arg needs an expression, and what its def-tree holds decides whether one
  // can be placed at the top of the body at all. Measured over the corpus, the tree is PURE
  // arithmetic over a loop variable in 11 of 12 (`preupdate_exit_pure`), a memory READ in none
  // (`preupdate_exit`), and a CALL in one (`preupdate_exit_call`, and `_wrapup_reent`, which stops
  // one guard later still on "a post-loop value inlines a 'call' from inside the loop").
  //
  // So the three EXIT rows are the three tiers, not three copies: a fix for the pure tier closes
  // the real bucket and must leave the other two declined, which is what makes them controls
  // rather than duplicates. The pure row puts a STORE in the body AHEAD of the def, which is the
  // harder of the two shapes the corpus has — ten of the twelve have no effect in the latch block
  // at all, and `LoadBGTilemapData`, the function this link is being walked for, is the one that
  // does. A pure tree may be recomputed across it; a tree that read memory could not.
  //
  // agbcc only, and the reason is the whole point: the shape IS the ARM rotation. Given the same C,
  // ido/kmc/mwcc schedule the update after the test and the pre-update read never arises, so the
  // rows would be four more ordinary loops on those toolchains rather than coverage.
  {
    sym: 'preupdate_cond',
    src: 'int preupdate_cond(int i){ int b = 0; if (i == 0) return 0; while (((i >> b++) & 1) == 0) ; return b; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "a post-increment inside the loop condition's own operand (`i >> b++`), so the test reads the " +
      'value the variable held one step before the update the compiler has already emitted',
  },
  {
    sym: 'preupdate_exit',
    src:
      'int preupdate_exit(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { r = *q + n; q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "the loop's exiting edge carries a value computed from the loop variables BEFORE their update " +
      '(`*q + n`). The `q = p + n` init is load-bearing: without a preheader the entry guard fuses ' +
      'into the loop and the function is refused for an unrelated reason',
  },
  {
    sym: 'preupdate_exit_pure',
    src:
      'int preupdate_exit_pure(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { *q = n; r = n << 3; q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "the loop's exiting edge carries PURE arithmetic over the loop variable (`n << 3`), computed " +
      'before the update and read after the loop. The body stores through a second loop variable ' +
      'first, so the value the edge carries is defined behind an effect it must not be reordered ' +
      'across — the shape every real function on this decline has',
  },
  {
    sym: 'preupdate_exit_call',
    src:
      'int cb(int *p);\n' +
      'int preupdate_exit_call(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { r = cb(q); q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      "an exiting edge carrying a CALL's result computed from the pre-update loop variable. The call " +
      'is a SECOND refusal sitting behind the pre-update one, so this row is expected to stay ' +
      'declined even once the pre-update read itself is recovered',
  },
  {
    sym: 'preupdate_escape',
    src:
      'struct N { struct N *next; int v; };\n' +
      'void preupdate_escape(struct N *f, int n, int **out){ int *s = 0;' +
      ' do { s = &f->v; f = f->next; } while (--n); *out = s; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'struct N; void preupdate_escape(struct N*,int,int**);',
    proto: { preupdate_escape: { returnsVoid: true } },
    note:
      'the trailing-pointer idiom where the trailing value is DERIVED from the loop variable ' +
      '(`&f->v`) rather than being the variable itself, and is read after the loop has moved on',
  },

  // A CONTROL-FLOW short-circuit: an `&&`/`||` that produces no value, only a branch. `a && b`
  // guarding X and its De Morgan dual `!a || !b` guarding Y are the same program, and agbcc lays
  // the arms out in SOURCE order — so they are different bytes, and which one was written is
  // recorded in the branch senses. A decompiler therefore has to choose, and choosing wrong costs
  // the whole function. The three rows are the two orientations, plus the distance that decides
  // whether the shape is recognised at all.
  //
  // `ifand_near` and `ifand_far` differ in ONE thing: whether the guarded arm fits inside a Thumb
  // conditional branch's ±256-byte reach. That one distance changes TWO things at once, and the
  // second is easy to miss.
  //
  // It changes what the recogniser can SEE. Past the range agbcc spells the branch
  // `bne .L1 / b .L2 @long jump`, and a frontend that splits a block at every conditional branch
  // turns that second instruction into a block whose only op is `br`, sitting on the edge into the
  // shared block. A recogniser keyed on successor identity cannot see through those, so the fold
  // resolves the chain before comparing (raise/shortcircuit.ts `forwardingTarget`).
  //
  // And it changes the branch POLARITY, which is what decides the ORIENTATION the fold would emit.
  // A short branch is `beq shared`, putting the second test on the FALL edge; the long form
  // inverts to `bne <second test>`, putting it on the TAKEN edge. Those are the fold's two arms —
  // `logic_or` and `logic_and` — so the near row and the far row do not exercise one code path at
  // two sizes, they exercise BOTH paths. MEASURED, and it is the opposite of what the distance
  // suggests: the near row folds to the swapped `||` and misses, while the far row folds to `&&`,
  // the source's own orientation, and matches.
  //
  // `ifor_near` is the ORIENTATION control. The same shape written the other way round matches
  // today, so the gap is not "this shape is unrecoverable" but "one of the fold's two arms emits
  // the spelling the compiler did not, and nothing referees it" — and a row that could falsify the
  // claim is worth more than a third that restates it. There is deliberately no `ifor_far`:
  // measured, a `||` matches at BOTH distances.
  //
  // TOOLCHAINS, measured rather than assumed — and the answer differs per row.
  //
  // The two `near` rows run on agbcc AND mwcc, because the orientation defect is not an agbcc
  // fact: on PowerPC the fold commits to the same `||` spelling, `ifand_near` misses by 18 and
  // `ifor_near` matches, exactly as on Thumb. Two ISAs and two compilers agreeing is what says the
  // gap is in the recogniser and the sense lever rather than in anything about ARM.
  //
  // The other two toolchains are excluded because on them THE CONSTRUCT IS NOT THERE, which is a
  // stronger reason than "it would be an ordinary row":
  //   • gcc2.7.2kmc compiles `if (a && b)` BRANCHLESSLY — `sltu; sltu; and; beqz`. One branch, no
  //     second test, nothing for a short-circuit recogniser to recognise.
  //   • ido7.1 fills both branch DELAY SLOTS with work hoisted out of the arms (`beqz a0,…` /
  //     `li t0,-1`, which is the shared arm's stored value). That makes the second test's block
  //     impure, and the fold refuses on exactly the ground it documents. The shape dissolves on a
  //     delay-slot ISA.
  //
  // `ifand_far` stays agbcc-only, and here the original reason does hold: the row IS the Thumb
  // ±256-byte branch range, and no other target has one. mwcc additionally declines it outright on
  // `stack pointer r1 used as data` (its `_savegpr_14` prologue does `addi r11,r1,80`), which has
  // nothing to do with short circuits.
  //
  // The arm's CONTENT is filler and its SIZE is the feature, so the near arm is a literal PREFIX
  // of the far one and all three share a signature. Two pointers, deliberately: a Thumb
  // `str Rd,[Rn,#N]` reaches offset 124, and a single array long enough to force the long branch
  // would spill past it into a pointer walk — a second recovery idiom riding along inside what is
  // supposed to be a one-variable control.
  //
  // WHAT THESE ROWS MOVE, so the headline is not read as progress: five rows take asmlift 372 →
  // 375 and m2c 348 → 348. All three gained matches are synthetic rows authored for an
  // asmlift-specific gap, one of them (`ifand_far`) scoring MATCH either way — a byte score cannot
  // see the difference between the recovered `&&` and the tail-duplicated spelling agbcc
  // cross-jumps back together, so a test pins that orientation, not this row; and
  // every row reads `noncompile` for m2c on an unrelated pointer-spelling defect of its own, which
  // on `ifand_near` hides that its orientation is the RIGHT one. The two gates are not the same
  // either: `bench regression` fails only on a LOST match, so it holds `ifand_far` and `ifor_near`
  // and says nothing about `ifand_near` — that one is pinned by
  // packages/cli/test/matching/shortcircuit-branch.test.ts, which runs with the benchmark refresh
  // rather than on every PR.
  {
    sym: 'ifand_near',
    src: 'int ifand_near(int a, int b, int *p, int *q){ if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int ifand_near(int,int,int*,int*);',
    note:
      'the diff is not a near miss but the whole spelling: the arms are exchanged and the ' +
      "condition negated. m2c prints the source's own orientation here, and its output is " +
      'byte-exact once the `->unkN` pointer spelling it declines on is legalised — so the ' +
      'noncompile beside this row is an unrelated defect of its own, not distance from a match',
  },
  {
    sym: 'ifand_far',
    src: 'int ifand_far(int a, int b, int *p, int *q){ if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; p[2] = 5; q[2] = 6; p[3] = 7; q[3] = 8; p[4] = 9; q[4] = 10; p[5] = 11; q[5] = 12; p[6] = 13; q[6] = 14; p[7] = 15; q[7] = 16; p[8] = 17; q[8] = 18; p[9] = 19; q[9] = 20; p[10] = 21; q[10] = 22; p[11] = 23; q[11] = 24; p[12] = 25; q[12] = 26; p[13] = 27; q[13] = 28; p[14] = 29; q[14] = 30; p[15] = 31; q[15] = 32; p[16] = 33; q[16] = 34; p[17] = 35; q[17] = 36; p[18] = 37; q[18] = 38; p[19] = 39; q[19] = 40; p[20] = 41; q[20] = 42; p[21] = 43; q[21] = 44; p[22] = 45; q[22] = 46; p[23] = 47; q[23] = 48; p[24] = 49; q[24] = 50; p[25] = 51; q[25] = 52; p[26] = 53; q[26] = 54; p[27] = 55; q[27] = 56; p[28] = 57; q[28] = 58; p[29] = 59; q[29] = 60; p[30] = 61; q[30] = 62; p[31] = 63; q[31] = 64; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc'],
    ctx: 'int ifand_far(int,int,int*,int*);',
    note:
      'the guarded arm is far enough that agbcc inverts the branch and puts the shared block behind ' +
      'a long-branch trampoline on each edge. The fold looks through them, and this orientation ' +
      "lands on the source's own `&&` rather than the dual `ifand_near` gets. The SCORE cannot " +
      'police that: the un-folded spelling tail-duplicates the else arm and agbcc cross-jumps the ' +
      'copies back together, so this row read MATCH before the shape was recovered too — what the ' +
      'orientation is pinned by is a test, not this number',
  },
  {
    sym: 'ifor_near',
    src: 'int ifor_near(int a, int b, int *p, int *q){ if (a || b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int ifor_near(int,int,int*,int*);',
  },

  // The DMA-fill idiom, WITH an uninitialised local — the pair no real row carries. An escaping
  // frame address retracts every `undef` in the function, on the premise that a callee may write
  // any frame offset; a DMA SOURCE register is the case where that premise is false, because the
  // engine only reads through it and the register is write-only, so the address cannot come back. This row is the ACCEPTING half of that rule, and what it is worth
  // is bounded: ablating `readOnlyAddressSinks` takes it from `nonmatch` to `declined`, so it is a
  // real gate — but `bench regression` fails only on a LOST MATCH, and this row does not match, so
  // a re-widening lands in the flip list rather than breaking the build. The failing guard is the
  // frontend unit test, where the direction is pinned by ablation. Note also that asmlift lifts
  // this and m2c declines it, so a row authored for an asmlift capability moves the declined/
  // nonmatch columns one in asmlift's favour.
  // agbcc only: the addresses are GBA MMIO, and on the other toolchains this is three stores to
  // nothing in particular. Ten live locals for the same reason uninit_spill has them — below that
  // agbcc keeps the uninitialised local in a register and the frame is never touched.
  {
    sym: 'dma_fill_uninit',
    src:
      'int dma_fill_uninit(int k,int *p,void *dest){ volatile unsigned short tmp;' +
      ' int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' tmp=(unsigned short)k;' +
      ' *(volatile unsigned int *)0x040000D4=(unsigned int)&tmp;' +
      ' *(volatile unsigned int *)0x040000D8=(unsigned int)dest;' +
      ' *(volatile unsigned int *)0x040000DC=0x81000020;' +
      ' for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'memory', 'array'],
    toolchains: ['agbcc'],
  },

  // ── float (soft-float on GBA; hardware FPU elsewhere) ───────────────────────────────────────
  {
    sym: 'fadd',
    src: 'float fadd(float a,float b){ return a+b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fadd(float,float);',
  },
  {
    sym: 'fsub',
    src: 'float fsub(float a,float b){ return a-b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fsub(float,float);',
  },
  {
    sym: 'fmul',
    src: 'float fmul(float a,float b){ return a*b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fmul(float,float);',
  },
  {
    sym: 'fdiv',
    src: 'float fdiv(float a,float b){ return a/b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fdiv(float,float);',
  },
  { sym: 'fcmp', src: 'int fcmp(float a,float b){ return a>b; }', features: ['float', 'compare'], toolchains: ALL },
  {
    sym: 'i2f',
    src: 'float i2f(int x){ return (float)x; }',
    features: ['float', 'cast', 'int-to-float'],
    toolchains: ALL,
    ctx: 'float i2f(int);',
  },
  {
    sym: 'f2i',
    src: 'int f2i(float x){ return (int)x; }',
    features: ['float', 'cast', 'float-to-int'],
    toolchains: ALL,
    ctx: 'int f2i(float);',
  },
  {
    sym: 'fma1',
    src: 'float fma1(float a,float b,float c){ return a*b+c; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fma1(float,float,float);',
  },
  {
    sym: 'dadd',
    src: 'double dadd(double a,double b){ return a+b; }',
    features: ['float', 'double', 'arithmetic'],
    toolchains: ALL,
  },

  // ── 64-bit (long long — soft 64-bit ops) ────────────────────────────────────────────────────
  {
    sym: 'lladd',
    src: 'long long lladd(long long a,long long b){ return a+b; }',
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llsub',
    src: 'long long llsub(long long a,long long b){ return a-b; }',
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llshl',
    src: 'long long llshl(long long a,int b){ return a<<b; }',
    features: ['int64'],
    toolchains: ALL,
  },
  {
    sym: 'llshr',
    src: 'long long llshr(long long a,int b){ return a>>b; }',
    features: ['int64', 'signed'],
    toolchains: ALL,
  },
  { sym: 'i2ll', src: 'long long i2ll(int x){ return x; }', features: ['int64', 'sign-extend'], toolchains: ALL },
  {
    sym: 'll2i',
    src: 'int ll2i(long long x){ return (int)x; }',
    features: ['int64', 'cast', 'narrow'],
    toolchains: ALL,
  },
  {
    sym: 'llcmp',
    src: 'int llcmp(long long a,long long b){ return a<b; }',
    features: ['int64', 'compare'],
    toolchains: ALL,
  },

  // ── division / modulo by constant (magic-number division) ───────────────────────────────────
  {
    sym: 'divc10',
    src: 'int divc10(int a){ return a/10; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'divc100',
    src: 'int divc100(int a){ return a/100; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'udivc10',
    src: 'unsigned udivc10(unsigned a){ return a/10; }',
    features: ['arithmetic', 'div-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'umod10',
    src: 'unsigned umod10(unsigned a){ return a%10; }',
    features: ['arithmetic', 'mod-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'modpow2',
    src: 'int modpow2(int a){ return a%16; }',
    features: ['arithmetic', 'mod-pow2', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'avg2',
    src: 'int avg2(int a,int b){ return (a+b)/2; }',
    features: ['arithmetic', 'div-pow2', 'signed'],
    toolchains: ALL,
  },

  // ── bit manipulation ────────────────────────────────────────────────────────────────────────
  {
    sym: 'rotl',
    src: 'unsigned rotl(unsigned x,int n){ return (x<<n)|(x>>(32-n)); }',
    features: ['rotate'],
    toolchains: ALL,
  },
  {
    sym: 'rotr',
    src: 'unsigned rotr(unsigned x,int n){ return (x>>n)|(x<<(32-n)); }',
    features: ['rotate'],
    toolchains: ALL,
    ctx: 'unsigned rotr(unsigned,int);',
  },
  {
    sym: 'extractbits',
    src: 'unsigned extractbits(unsigned x){ return (x>>4)&0xF; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'clearbit',
    src: 'int clearbit(int x,int n){ return x & ~(1<<n); }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'togglebit',
    src: 'int togglebit(int x,int n){ return x ^ (1<<n); }',
    features: [],
    toolchains: ALL,
  },
  { sym: 'hi16', src: 'unsigned hi16(unsigned x){ return x>>16; }', features: [], toolchains: ALL },
  {
    sym: 'mergebits',
    src: 'unsigned mergebits(unsigned a,unsigned b){ return (a&0xFFFF)|(b<<16); }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'signum',
    src: 'int signum(int x){ return (x>0)-(x<0); }',
    features: ['compare'],
    toolchains: ALL,
  },

  // ── compare / branchless / select ───────────────────────────────────────────────────────────
  {
    sym: 'absdiff',
    src: 'int absdiff(int a,int b){ return a>b?a-b:b-a; }',
    features: ['compare'],
    toolchains: ALL,
  },
  {
    sym: 'clampu8',
    src: 'int clampu8(int x){ if(x<0)return 0; if(x>255)return 255; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'max3',
    src: 'int max3(int a,int b,int c){ int m=a>b?a:b; return m>c?m:c; }',
    features: ['compare'],
    toolchains: ALL,
  },
  {
    sym: 'selnz',
    src: 'int selnz(int c,int a,int b){ return c?a:b; }',
    features: ['compare'],
    toolchains: ALL,
  },
  { sym: 'notb', src: 'int notb(int x){ return !x; }', features: ['compare', 'bool'], toolchains: ALL },

  // ── memory / arrays / structs ───────────────────────────────────────────────────────────────
  {
    sym: 'swapp',
    src: 'void swapp(int *a,int *b){ int t=*a;*a=*b;*b=t; }',
    features: ['memory', 'store', 'load'],
    toolchains: ALL,
    ctx: 'void swapp(int*,int*);',
    proto: { swapp: { returnsVoid: true } },
  },
  {
    sym: 'hword',
    src: 'void hword(u16 *p,int i,int v){ p[i]=(u16)v; }',
    features: ['memory', 'array', 'store', 'narrow'],
    toolchains: ALL,
    ctx: 'void hword(u16*,int,int);',
    proto: { hword: { returnsVoid: true } },
  },
  {
    sym: 'memcpy1',
    src: 'void memcpy1(u8 *d,u8 *s,int n){ int i; for(i=0;i<n;i++)d[i]=s[i]; }',
    features: ['memory', 'store', 'load'],
    toolchains: ALL,
    ctx: 'void memcpy1(u8*,u8*,int);',
    proto: { memcpy1: { returnsVoid: true } },
  },
  {
    sym: 'revarr',
    src: 'void revarr(int *a,int n){ int i,j,t; for(i=0,j=n-1;i<j;i++,j--){t=a[i];a[i]=a[j];a[j]=t;} }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void revarr(int*,int);',
    proto: { revarr: { returnsVoid: true } },
  },
  {
    sym: 'maxarr',
    src: 'int maxarr(int *a,int n){ int m=a[0],i; for(i=1;i<n;i++)if(a[i]>m)m=a[i]; return m; }',
    features: ['memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'countpos',
    src: 'int countpos(int *a,int n){ int c=0,i; for(i=0;i<n;i++)if(a[i]>0)c++; return c; }',
    features: ['memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'dotprod',
    src: 'int dotprod(int *a,int *b,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]*b[i]; return s; }',
    features: ['memory', 'arithmetic'],
    toolchains: ALL,
    ctx: 'int dotprod(int*,int*,int);',
  },
  {
    sym: 'structarr',
    src: 'struct P{int x;int y;};\nint structarr(struct P *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i].x; return s; }',
    features: ['struct', 'memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'setfield',
    src: 'struct S{int a;int b;int c;};\nvoid setfield(struct S *s,int v){ s->a=v; s->c=v; }',
    features: ['struct', 'field', 'store'],
    toolchains: ALL,
    ctx: 'struct S; void setfield(struct S*,int);',
    proto: { setfield: { returnsVoid: true } },
  },
  {
    sym: 'strcmp1',
    src: 'int strcmp1(char *a,char *b){ while(*a && *a==*b){a++;b++;} return *a-*b; }',
    features: ['memory', 'pointer', 'compare'],
    toolchains: ALL,
  },

  // ── loops (do-while, nested, break/continue, accumulators) ──────────────────────────────────
  {
    sym: 'gcd',
    src: 'int gcd(int a,int b){ while(b){int t=b;b=a%b;a=t;} return a; }',
    features: ['mod-reg'],
    toolchains: ALL,
  },
  {
    sym: 'fib',
    src: 'int fib(int n){ int a=0,b=1,i; for(i=0;i<n;i++){int t=a+b;a=b;b=t;} return a; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'powi',
    src: 'int powi(int base,int e){ int r=1,i; for(i=0;i<e;i++)r*=base; return r; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'nestedloop',
    src: 'int nestedloop(int n){ int s=0,i,j; for(i=0;i<n;i++)for(j=0;j<n;j++)s+=i*j; return s; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'dowhile',
    src: 'int dowhile(int n){ int s=0; do{s+=n;n--;}while(n>0); return s; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'breakloop',
    src: 'int breakloop(int *a,int n){ int i; for(i=0;i<n;i++)if(a[i]<0)break; return i; }',
    features: ['break', 'memory'],
    toolchains: ALL,
  },
  {
    sym: 'continueloop',
    src: 'int continueloop(int *a,int n){ int s=0,i; for(i=0;i<n;i++){if(a[i]<0)continue;s+=a[i];} return s; }',
    features: ['continue', 'memory'],
    toolchains: ALL,
  },

  // ── casts / integer promotion ───────────────────────────────────────────────────────────────
  {
    sym: 'addu8',
    src: 'u8 addu8(u8 a,u8 b){ return a+b; }',
    features: ['narrow', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'promsh',
    src: 'int promsh(s16 a,s16 b){ return a+b; }',
    features: ['promotion', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'narrow',
    src: 'void narrow(u8 *p,int x){ *p=(u8)x; }',
    features: ['cast', 'narrow', 'memory', 'store'],
    toolchains: ALL,
    ctx: 'void narrow(u8*,int);',
    proto: { narrow: { returnsVoid: true } },
  },
  {
    sym: 'truncmul',
    src: 's16 truncmul(s16 a,s16 b){ return a*b; }',
    features: ['narrow', 'arithmetic'],
    toolchains: ALL,
  },

  // WHERE A VALUE LIVES, NOT WHAT IT COMPUTES. In each of these rows both decompilers can
  // recover the computation; the diff is dominated by value placement — a base address kept in
  // one register and reused at immediate offsets, a clamp overwriting its own variable, a value
  // parked across a high-pressure loop. The family is cut from kleod:LoadBGTilemapData:agbcc,
  // whose residual diff is almost entirely this class, but every shape is spelled with absolute
  // addresses so the rows stay self-contained (no ELF, no extern data — a candidate could not
  // declare one).
  //
  // The absolute base is PER-PLATFORM, so the spelled address is one the console actually has:
  // under agbcc the GBA DMA3 register file / EWRAM / IWRAM; under ido and kmc the N64 PI
  // register file (the osPiRawStartDma store pattern) and KSEG0 RDRAM; under mwcc the GC DI
  // register file (the DVDLowRead store pattern) and MEM1. Same spelling, same capability —
  // only the constant and the register offsets differ — so a sym appears in several specs with
  // DISJOINT toolchain lists and every `synthetic:sym:toolchain` id stays unique.
  //
  // What each row isolates, measured by compiling both spellings under agbcc -O2:
  // `dma_burst` is the control — a plain store block through one pointer local, recovered
  // today by the base-pointer lever. `dma_wait` adds the busy-wait read-back through the SAME
  // pointer; the lever withdraws and the candidate falls back to one literal per store, which
  // costs the shared base register (gcc 2.9 folds `(vu32*)0x040000d8` to a fresh constant at
  // parse time, so only a spelling that keeps ONE base expression gets `str [rN, #imm]`).
  // `bg_area` groups three fields of one struct element — recovered, leaving only the operand
  // order of the commutative multiply (the target loads .w then .h; the candidate the reverse).
  // `bg_mix` adds a FIXED element of the same array: the target derives `[2].h` from the same
  // base register (`add #0x38`); the candidate anchors a second absolute base, splitting the
  // object in two. `clamp_inplace` is a one-sided overwrite (`if (w > 31) w = 32;`): rendering
  // it as a two-sided assignment into a fresh temp costs a register, a callee-save push, and
  // flips the branch polarity. `hipress` parks one byte across a loop hot enough to fill r0-r7,
  // so the target homes it in a call-saved HI register touched only by `mov` (gcc's alternate-
  // class allocation; hi regs cost 4 vs 2 to move but beat an 8-cost SImode reload) — the
  // candidate instead sinks the load below the loop and re-associates the accumulator chain.
  //
  // The placement question is universal (MIPS %hi/%lo anchoring, PPC @ha/@l pairs, all four
  // compilers' in-place-update patterns), and where a toolchain's own addressing rules make a
  // shape free, the row is a control there rather than coverage.
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 src,u32 dst,u32 cnt){ volatile u32 *dma = (volatile u32 *)0x040000d4;' +
      ' dma[0] = src; dma[1] = dst; dma[2] = cnt; }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dma_burst(u32 src, u32 dst, u32 cnt);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 dram,u32 cart,u32 len){ volatile u32 *pi = (volatile u32 *)0xa4600000;' +
      ' pi[0] = dram; pi[1] = cart; pi[3] = len; }',
    features: ['value-home', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void dma_burst(u32 dram, u32 cart, u32 len);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 mar,u32 len,u32 cr){ volatile u32 *di = (volatile u32 *)0xcc006000;' +
      ' di[5] = mar; di[6] = len; di[7] = cr; }',
    features: ['value-home', 'pointer'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void dma_burst(u32 mar, u32 len, u32 cr);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 src,u32 dst,u32 cnt){ volatile u32 *dma = (volatile u32 *)0x040000d4;' +
      ' dma[0] = src; dma[1] = dst; dma[2] = cnt | 0x80000000; while (dma[2] & 0x80000000) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dma_wait(u32 src, u32 dst, u32 cnt);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 dram,u32 cart,u32 len){ volatile u32 *pi = (volatile u32 *)0xa4600000;' +
      ' pi[0] = dram; pi[1] = cart; pi[3] = len; while (pi[4] & 3) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void dma_wait(u32 dram, u32 cart, u32 len);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 mar,u32 len,u32 cr){ volatile u32 *di = (volatile u32 *)0xcc006000;' +
      ' di[5] = mar; di[6] = len; di[7] = cr | 1; while (di[7] & 1) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void dma_wait(u32 mar, u32 len, u32 cr);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'bg_area',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x02000000)\n' +
      's32 bg_area(s32 i){ return gBgs[i].w * gBgs[i].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 bg_area(s32 i);',
  },
  {
    sym: 'bg_area',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x80200000)\n' +
      's32 bg_area(s32 i){ return gBgs[i].w * gBgs[i].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 bg_area(s32 i);',
  },
  {
    sym: 'bg_mix',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x02000000)\n' +
      's32 bg_mix(s32 i){ return gBgs[i].w * gBgs[2].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 bg_mix(s32 i);',
  },
  {
    sym: 'bg_mix',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x80200000)\n' +
      's32 bg_mix(s32 i){ return gBgs[i].w * gBgs[2].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 bg_mix(s32 i);',
  },
  {
    sym: 'clamp_inplace',
    src:
      '#define gW ((volatile u16 *)0x03000010)\n' +
      's32 clamp_inplace(s32 n){ s32 total = 0; s32 j;' +
      ' for (j = 0; j < n; j++){ s32 w = gW[j]; if (w > 31){ w = 32; } total += w; } return total; }',
    features: ['value-home'],
    toolchains: ['agbcc'],
    ctx: 's32 clamp_inplace(s32 n);',
  },
  {
    sym: 'clamp_inplace',
    src:
      '#define gW ((volatile u16 *)0x80200010)\n' +
      's32 clamp_inplace(s32 n){ s32 total = 0; s32 j;' +
      ' for (j = 0; j < n; j++){ s32 w = gW[j]; if (w > 31){ w = 32; } total += w; } return total; }',
    features: ['value-home'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 clamp_inplace(s32 n);',
  },
  // No mwcc_242_81 on `hipress`: one of the scored candidates sends mwcc -O4's global optimizer
  // into a non-terminating compile (>15 min CPU-bound on a single cand.c), which would stall
  // every full run. The homes it measures (hi-reg parking, ip counter) are Thumb/MIPS facts.
  {
    sym: 'hipress',
    src:
      's32 hipress(u8 *p, s32 n){ s32 keep = p[1];' +
      ' s32 a = p[2], b = p[3], c = p[4], d = p[5], e = p[6], f = p[7], g = p[8]; s32 i;' +
      ' for (i = 0; i < n; i++){ a += b * c; b += d * e; c += f * g; d += a; e += b; f += c; g += d; }' +
      ' return keep + a + b + c + d + e + f + g; }',
    features: ['value-home', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc'],
    ctx: 's32 hipress(u8 *p, s32 n);',
  },
  // The EXPRESSION-home third of the family (the first two thirds: `dma_*` = one base pointer's
  // home, `hipress` = a loaded value's home). Under loop pressure agbcc computes a repeated
  // expensive expression ONCE and homes it — a loop-invariant shift hoisted into a callee-saved
  // register, a two-instruction constant materialized once per iteration and read back, an
  // incremented counter parked in `ip` — where a per-use spelling re-derives each of them.
  // `sizehome` isolates the invariant hoist (w>>1 lands in TWO homes, one per signedness, plus
  // the VRAM base constant); `maskhome` is the composite frame-copy + DMA shape (the inner copy
  // loop adds the pressure that turns every home callee-saved); `fieldbase` isolates neighbor
  // CELLS of one object derived from a single base register (`add #72`/`add #74` off one pool
  // word where the halfword offset exceeds the load range, the word offset staying inline) — a
  // per-cell spelling anchors one pool constant per address instead. `dma_wait:agbcc` is the
  // whole third's control: the same mask reused once, in a function small enough that
  // re-materializing is what the compiler does too.
  //
  // agbcc only. The poll loops decline on ido7.1/gcc2.7.2kmc's branch-likely lift gap, so those
  // lanes would measure that link, not this family (`dma_wait` already carries the attributed
  // declines); mwcc_242_81 stays off per the `hipress` hazard policy until a probe clears it.
  {
    sym: 'sizehome',
    src:
      'void sizehome(u8 *dst, s32 w, s32 n){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void sizehome(u8 *dst, s32 w, s32 n);',
    proto: { sizehome: { returnsVoid: true } },
  },
  {
    sym: 'maskhome',
    src:
      'void maskhome(u8 *src, u8 *dst, s32 w, s32 h){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 x, y;' +
      ' for (y = 0; y < h; y++){' +
      ' for (x = 0; x < w; x++){ dst[x] = src[x + w * y]; }' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * y;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' if (dma[2] & 0x80000000) { do {} while (dma[2] & 0x80000000); } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void maskhome(u8 *src, u8 *dst, s32 w, s32 h);',
    proto: { maskhome: { returnsVoid: true } },
  },
  {
    sym: 'fieldbase',
    src:
      'void fieldbase(s32 n){' +
      ' u8 *b = (u8 *)0x03001000; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' if (i < *(u16 *)(b + 72)) { *(u16 *)(b + 74) = i; }' +
      ' *(s32 *)(b + 112) = i; } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void fieldbase(s32 n);',
    proto: { fieldbase: { returnsVoid: true } },
  },
];

// ── C++ (mwcc `.cp` frontend, PPC only) ───────────────────────────────────────────────────
// The measured symbol is an `extern "C"` wrapper: the method inlines into it at -O4, so the row
// measures C++ codegen (this-pointer member access) under a symbol name BOTH decompilers can
// spell — candidates stay plain C and score through the normal C path. A mangled-method axis
// (scoring `len2__3VecFv` itself, asmlift's cpp backend vs m2c's demangler) is future dataset work.
export const SYNTHETIC_CPP: SynthSpec[] = [
  {
    sym: 'Vec__len2',
    lang: 'c++',
    src: 'struct Vec{int x;int y;int len2(){ return x*x+y*y; }};\nextern "C" int Vec__len2(Vec*v){ return v->len2(); }',
    features: ['method'],
    toolchains: ['mwcc_242_81'],
    note: 'C++ method via this-pointer',
  },
  {
    sym: 'Counter__inc',
    lang: 'c++',
    src: 'struct Counter{int n;void inc(){ n++; }};\nextern "C" void Counter__inc(Counter*c){ c->inc(); }',
    features: ['method'],
    toolchains: ['mwcc_242_81'],
    // `struct` spelled out: the ctx must parse as C (m2c's context parser) AND as C++
    ctx: 'struct Counter; void Counter__inc(struct Counter*);',
    proto: { Counter__inc: { returnsVoid: true } },
  },
];
