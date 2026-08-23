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
  //     MEASURED: both agbcc rows byte-MATCH anyway, because the invented parameter lands in the
  //     register the local was allocated to — `uninit_sw(s32 a0, s32 a1, s32 a2)` for a
  //     two-argument function, and `uninit_join(s32 a0, s32 a1)` for a one-argument one. A trailing
  //     parameter nothing reads costs nothing on this ABI. That is a fidelity gap the byte score
  //     cannot see, and the reason these rows are worth keeping green: they are the rows where a
  //     future `undef` must change the C and NOT the bytes. The loop-carried version of the same
  //     fabrication is not free, and has its own family (`loopfall`, below).
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
  // The COMPOSITION and PLACEMENT aggravations behind the single-loop rows above, each verified
  // against the reference compile. `dmafield` fuses fieldbase's neighbor cells with dma_wait's
  // poll block in one function — each shape matches alone, but the levers that close them
  // (/nearbase; /livebase + the poll spelling) live in different candidates, so the composition
  // is reachable from neither. `armhomes` runs the SAME hot DMA loop in both arms of an `if`:
  // the reference homes the mask and the invariants PER ARM and re-materializes the mask again
  // for each poll (per-region homes — a whole-function home is the wrong placement, and the
  // sibling rows' single-loop preheader home cannot express it). `nestinit` is sizehome's exact
  // shape nested inside a guard: the init-first re-spelling is restricted to the top-level
  // statement list by its skip-path soundness gate, so the nested guard keeps testing the bound
  // instead of the initialized counter. sizehome/maskhome are the single-loop controls.
  //
  // agbcc only, as the sibling block above: the polls decline on ido/kmc branch-likely, and
  // mwcc_242_81 stays off per the hipress hazard policy.
  {
    sym: 'dmafield',
    src:
      'void dmafield(s32 n){' +
      ' u8 *b = (u8 *)0x03001000;' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' if (i < *(u16 *)(b + 72)) { *(u16 *)(b + 74) = i; }' +
      ' dma[0] = (s32)(b + 112); dma[1] = *(s32 *)(b + 112);' +
      ' dma[2] = i | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dmafield(s32 n);',
    proto: { dmafield: { returnsVoid: true } },
  },
  {
    sym: 'armhomes',
    src:
      'void armhomes(u8 *dst, s32 w, s32 n, s32 sel){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' if (sel) {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} }' +
      ' } else {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)(dst + w); dma[1] = 0x06008000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void armhomes(u8 *dst, s32 w, s32 n, s32 sel);',
    proto: { armhomes: { returnsVoid: true } },
  },
  {
    sym: 'nestinit',
    src:
      'void nestinit(u8 *dst, s32 w, s32 n, s32 go){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' if (go != 0) {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void nestinit(u8 *dst, s32 w, s32 n, s32 go);',
    proto: { nestinit: { returnsVoid: true } },
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
  // The TYPED-home fourth of the family: what the first three thirds hoisted, this third TYPES.
  // On the real function the residual splits three ways, each verified by compiling the pair.
  // `sizebound` — the repeated `16 << t` homed in a **u32** local: the type is load-bearing
  // twice over (the home's compares against a u16 load and the shift bound come out UNSIGNED —
  // `bcs`/`bcc` where an s32 home gives `bge`/`blt` — and the s32-home spelling of the same
  // hoist REGRESSES the real function, so a home lever without the width/sign choice cannot
  // close it). `ucmp` isolates the compare polarity alone, home-less: a u32 counter and a cast
  // bound flip four branches and ripple two register picks — the /uns-cmp axis spells the
  // compares from the lifted icmp facts, and the lane's residual is the register ripple those
  // picks leave behind. `entrypair` — one COMPUTED address (`(a0 << 2) +
  // (a1 << 1) + table`) held in a pointer local with its two bytes read at `[r,#1]`/`[r,#0]`:
  // the per-site spelling recomputes the chain and anchors a pool literal per baked offset
  // (`table`, `table+1`) where the original anchors one. /nearbase cannot see it — its clusters
  // are CONST deref bases; this base is an expression.
  //
  // `sizebound` is agbcc-only like its siblings (its poll loop declines on the MIPS lanes'
  // branch-likely link, and mwcc stays off per the `hipress` hazard policy). `ucmp` and
  // `entrypair` have no poll. Measured decline attributions: `ucmp:ido7.1` declines on the
  // pre-existing branch-likely lift link (`bnezl`), `ucmp:mwcc_242_81` on the guard-fusion
  // staleExit decline (the kept-guard family's link, not this one); `entrypair:gcc2.7.2kmc`
  // declines on the MIPS `jal` call link exactly as `call1:gcc2.7.2kmc` does. Those lanes
  // measure their links; the family's signal lanes are agbcc (all three), `ucmp:gcc2.7.2kmc`,
  // and `entrypair:mwcc_242_81`. `sizebound:agbcc`'s residual after the typed home landed is
  // TWO placement classes, measured disjoint and additive (8 + 8 = 16): the u16 pointer's init
  // placed at its OWN scope while the dma pointer's stays at the function top (the leaf-base
  // hoist is all-or-nothing, so the split placement is reachable from neither its function-top
  // nor its scoped form alone), and ONE counter shared across the two sequential inner loops.
  // Neither needs a new row. `ucmp:agbcc` already carries the shared-counter shape standalone —
  // merging its two counters closes it 6 -> 0 — and once that ships, this row is the split
  // placement's own demanding row (8 -> 0). What blocks them is existing code: two un-gated
  // heuristics in scopebase.ts (repeated-const-offset, nested-loop) that are not in a gate
  // table, and coalesce.ts's SOUND `loop` gate, whose blanket refusal stands in front of the
  // span model that already reasons about sequential siblings correctly — so it must be
  // replaced by a liveness argument, never ablated. The mwcc lane's residual is NOT the shared-base home the agbcc
  // lane closed (`/addr-home`): struct-arrays recovery consumes the full element address into
  // `[a0]` indexing, so the value the PPC target holds in r3 no longer exists in the IR to
  // home — a struct-element-home class the lane keeps measuring.
  {
    sym: 'sizebound',
    src:
      'void sizebound(s32 t, s32 n){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4;' +
      ' u32 size = 16 << t; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' u32 j;' +
      ' for (j = 0; j < *(u16 *)0x03001048; j++){ *(u8 *)(j + 0x03002000) = *(u8 *)(j + 0x03003000); }' +
      ' for (j = *(u16 *)0x03001048; j < size; j++){ *(u8 *)(j + 0x03002000) = 0; }' +
      ' dma[0] = 0x03002000;' +
      ' dma[1] = *(s32 *)0x03001070 + size * i;' +
      ' dma[2] = size >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'void sizebound(s32 t, s32 n);',
    proto: { sizebound: { returnsVoid: true } },
  },
  {
    sym: 'ucmp',
    src:
      'void ucmp(s32 t){' +
      ' u32 i;' +
      ' for (i = 0; i < *(u16 *)0x03001048; i++){ *(u8 *)(i + 0x03002000) = *(u8 *)(i + 0x03003000); }' +
      ' for (i = *(u16 *)0x03001048; i < (u32)(16 << t); i++){ *(u8 *)(i + 0x03002000) = 0; } }',
    features: ['unsigned'],
    toolchains: ALL,
    ctx: 'void ucmp(s32 t);',
    proto: { ucmp: { returnsVoid: true } },
  },
  {
    sym: 'entrypair',
    src:
      's32 g(s32 v);\n' +
      's32 entrypair(u32 a0, u32 a1){' +
      ' u8 *entry = (u8 *)((a0 << 2) + (a1 << 1) + 0x08057acc);' +
      ' s32 type = entry[1];' +
      ' s32 idx = entry[0];' +
      ' if (type == 2) { return g(*(s32 *)((idx << 3) + 0x08189ccc)); }' +
      ' return g(*(s32 *)((type - 2 << 2) + (idx << 3) + 0x08189ccc)); }',
    features: ['value-home', 'pointer'],
    toolchains: CALL,
    ctx: 's32 g(s32 v); s32 entrypair(u32 a0, u32 a1);',
    proto: { g: { params: 1 } },
  },

  // WHERE THE READ HAPPENS, not where the value lives. The sibling of the value-home family
  // above: there the diff is which register or offset holds a value; here it is which BLOCK
  // performs the read. agbcc has no instruction scheduler (gcc 2.9-arm's SRCS compiles neither
  // sched.c nor reorg.c), and its code-hoisting pass is compiled in but never runs: gcse.c
  // guards `one_code_hoisting_pass` behind `optimize_size`, which toplev.c sets only for -Os,
  // and every config here builds -O2. So a read SPELLED above a branch is EMITTED above it — the
  // direction these rows measure. (Not the converse: partial-redundancy elimination does run at
  // -O2, and compiled it inserts a load into a sibling arm the source never read in, so the asm's
  // read block is not proof of the source's.) Compiling the same read once-per-arm emits it once
  // per arm — a second load and a second pool literal for the folded address — so a decompiler
  // that renders a value at its USE site produces a spelling this compiler emits only for a source
  // that read per arm. Verified by compiling the pair: the two spellings differ, and the compiler
  // moves neither.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, where re-reading ONE entry byte in two sibling arms
  // is 15 points of the residual. Spelled with absolute GBA addresses so the rows stay
  // self-contained (no ELF, no extern data — a synthetic candidate could not declare one).
  //
  // `readshare` is the isolate: one absolute byte read, two sibling arms, nothing else moving.
  // `readarm` is its control — the same read with BOTH uses inside ONE arm, which asmlift
  // already anchors at the def site, so the capability must leave it exactly where it is.
  // `armshare` is the real function's shape (an indexed byte PAIR above two branches, the low
  // byte used in both arms); it moves further than the isolate because its residual also carries
  // the struct-array index that the /addr-home axis owns, so it is coverage, not an isolate.
  // `readcall` is the one shape a "two or more sibling arms" rule would MISS: a single use,
  // inside a short-circuit's right operand, feeding a call argument. It fails today for the same
  // reason, and separates a placement rule keyed on strict dominance from one keyed on arm count.
  //
  // agbcc only. The mechanism above is a fact about THIS compiler, established by reading its
  // pass list and confirmed by compiling both spellings. Whether ido7.1, gcc2.7.2kmc and
  // mwcc_242_81 move a read the same way was NOT measured, so those lanes are left off rather
  // than assumed: each needs its own read-it-then-compile-it pair before these rows mean
  // anything there.
  {
    sym: 'readshare',
    src:
      '#define gKind ((u8 *)0x08057acc)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void readshare(u32 c){ u32 s = *gKind;' +
      ' if (c & 1){ *gOutA = s << 3; } else { *gOutB = s << 4; } }',
    features: ['read-once', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void readshare(u32 c);',
    proto: { readshare: { returnsVoid: true } },
  },
  {
    sym: 'readarm',
    src:
      '#define gKind ((u8 *)0x08057acc)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void readarm(u32 c){ u32 s = *gKind;' +
      ' if (c & 1){ *gOutA = s << 3; *gOutB = s << 4; } }',
    features: ['read-once', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void readarm(u32 c);',
    proto: { readarm: { returnsVoid: true } },
  },
  {
    sym: 'armshare',
    src:
      'struct Ent { u8 kind; u8 mode; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      '#define gFlag ((u8 *)0x03003430)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void armshare(u32 a0, u32 a1){ struct Ent *e = &gEnts[(a0 << 1) + a1];' +
      ' u32 mode = e->mode; u32 kind = e->kind;' +
      ' if (*gFlag & 1){ if (mode == 2){ *gOutA = kind << 3; } else { *gOutB = kind << 4; } } }',
    features: ['read-once', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void armshare(u32 a0, u32 a1);',
    proto: { armshare: { returnsVoid: true } },
  },
  {
    sym: 'readcall',
    src:
      'struct Ent { u8 kind; u8 mode; };\n' +
      'struct Tile { s32 size; s32 pad; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      '#define gTiles ((struct Tile *)0x08189ccc)\n' +
      '#define gFlag ((u8 *)0x03003430)\n' +
      'u32 decomp(s32 n);\n' +
      'void readcall(u32 a0, u32 a1){ struct Ent *e = &gEnts[(a0 << 1) + a1];' +
      ' u32 mode = e->mode; u32 kind = e->kind;' +
      ' if ((*gFlag & 1) && mode == 2){ decomp(gTiles[kind].size); } }',
    features: ['read-once', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'u32 decomp(s32 n); void readcall(u32 a0, u32 a1);',
    proto: { decomp: { params: 1 }, readcall: { returnsVoid: true } },
  },

  // WHICH ARMS, IN WHICH ORDER. The read-once family above asks where a value is COMPUTED; this
  // one asks how a multi-way dispatch is GROUPED and SEQUENCED. Same compiler fact underneath:
  // agbcc has no instruction scheduler and no block reordering pass (gcc 2.9-arm's SRCS compiles
  // neither sched.c nor reorg.c), so a switch's case bodies are laid out in SOURCE order and the
  // dispatch tree above them is `expand_end_case`'s balanced search. Reading a 4-case switch back
  // therefore fixes both the grouping and the arm order, and getting either wrong moves every
  // instruction after the first arm.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, where it is the single largest class in the residual:
  // respelling its `if (v1 != 1) { if (v1 <= 1) { if (v1 == 0) … } else { switch { case 2, 3 } } }
  // else { … }` as one four-case `switch` is worth 46 of 547 points — more than every capability
  // the three previous rounds landed for that function, combined. Of the 46, the grouping is 8 and
  // the ARM ORDER is 38: asmlift emits the `!= 1` arm last because an if/else has nowhere else to
  // put it, while the asm lays that body out second.
  //
  // Two separate defects, one per row, both in structure/switch-recover.ts:
  //   • `swarms` — a switch with NO default, declining to if-nesting. The attribution that
  //     authored this row named the "default entry with a phi" guard, reasoning that the fall-out
  //     edge lands on the phi-carrying MERGE. The run falsified that: instrumenting every
  //     `return null` showed the shape declining at `defaults.length > 1`, and the phi guard never
  //     firing on this corpus at all. gcc 2.9-arm's `emit_case_nodes` gives every subtree that
  //     runs out of case values its OWN jump to the default, so a four-case tree reaches it
  //     through two bare `b .Ldefault` blocks — which recovery counted as two different defaults.
  //     The default candidate is one of those bare blocks, never the merge, which is why the phi
  //     guard cannot be what refuses this shape.
  //   • `swlayout` — the arms come back sorted by case VALUE. Its source order is 2, 0, 3, 1 and
  //     agbcc lays the bodies out in exactly that order; asmlift emits 0, 1, 2, 3, so every
  //     instruction after the first arm shifts. It carries a default, so recognition succeeds and
  //     ONLY the order is left — which is what separates it from `swarms`.
  //
  // `swdefault` is the control: byte-identical C to `swarms` except that the fall-out is spelled
  // as `default: w = 0;` instead of an initialiser, which gives the default its own block — one
  // default candidate, so it was recovered before the collapse and must stay recovered after it.
  // The collapse that closed `swarms` is what it guards: two leaves are one default only when each
  // is a bare EXIT to the same place carrying the same values, and this row's real default arm has
  // a body, so nothing may fold it into the fall-out.
  //
  // Two rows for the halves of the ordering rule the four above cannot see:
  //   • `swdefmid` — the same four cases with `default: w = 99;` written THIRD. agbcc expands the
  //     default's body where the source wrote it like any other arm, so its block lands between
  //     case 1's and case 2's, and emitting the label last moves every instruction after it.
  //   • `swjtorder` — five dense arms written 3, 0, 4, 1, 2, with a default. Five is enough for
  //     agbcc to emit a jump TABLE, whose slots are ascending by construction: grouping them in
  //     table order spells the arms 0..4 while the bodies are laid out in the order the arms were
  //     written. `sw_jt` above is the same regime with ascending arms, where the two orders
  //     coincide and the row cannot fire.
  //
  // And two for the `default:` positions those cannot see either, one per regime:
  //   • `swdeffirst` — the same four cases with `default:` written FIRST. That is the one position
  //     where the dispatch RUNS OUT into the default's block instead of jumping to it, and the
  //     reading recovery makes of a fall-through is the one thing the other subtree's surviving
  //     `b .Ldefault` licenses. `swdefmid` cannot see it: at position 2 both subtrees jump.
  //   • `swjtdefmid` — `swjtorder`'s five arms, ascending, with `default:` written THIRD. Under the
  //     jump table the default's body lands where the source wrote it too, and `swjtorder`'s own
  //     default is written LAST, where the layout spelling and C's conventional one coincide.
  //
  // `swmulti` is the real function's shape rather than an isolate: a defaultless switch inside a
  // do-while whose four arms all decide the same three locals. It moves furthest (38) because its
  // residual also carries the arm-order half and the loop's own value placement.
  //
  // NOT the same gap as `uninit_sw` above, which contains the identical dispatch: there the arms
  // leave a local undefined on the fall-out path, and the arm grouping alone takes that row to
  // MATCH, so the def-less read costs it nothing and the switch was all that stood between it and
  // its target. `swarms` assigns `w = 0` first, which is what keeps the two separable: it isolates
  // the dispatch with no `uninit-local` gap behind it at all.
  //
  // agbcc only, and for the same reason the read-once family is: the inference "the asm's block
  // order is the source's arm order" is a fact about a compiler with no scheduler and no block
  // reordering. The grouping half is a structurer defect and is ISA-independent, but whether
  // ido7.1, gcc2.7.2kmc and mwcc_242_81 preserve arm layout was NOT measured, so those lanes are
  // left off rather than assumed.
  {
    sym: 'swarms',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swarms(s32 mode, s32 n){ s32 w = 0;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swarms(s32 mode, s32 n);',
    proto: { swarms: { returnsVoid: true } },
  },
  {
    sym: 'swdefault',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdefault(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break;\n' +
      '                 default: w = 0; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdefault(s32 mode, s32 n);',
    proto: { swdefault: { returnsVoid: true } },
  },
  {
    sym: 'swdefmid',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdefmid(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 99; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdefmid(s32 mode, s32 n);',
    proto: { swdefmid: { returnsVoid: true } },
  },
  {
    sym: 'swjtorder',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swjtorder(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 3: w = n + 4; break; case 0: w = n + 1; break;\n' +
      '                 case 4: w = n + 5; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; default: w = 99; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'dense', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swjtorder(s32 mode, s32 n);',
    proto: { swjtorder: { returnsVoid: true } },
  },
  {
    sym: 'swdeffirst',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdeffirst(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { default: w = 99; break;\n' +
      '                 case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdeffirst(s32 mode, s32 n);',
    proto: { swdeffirst: { returnsVoid: true } },
  },
  {
    sym: 'swjtdefmid',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swjtdefmid(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 99; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break;\n' +
      '                 case 4: w = n + 5; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'dense', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swjtdefmid(s32 mode, s32 n);',
    proto: { swjtdefmid: { returnsVoid: true } },
  },
  {
    sym: 'swlayout',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swlayout(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 2: w = n + 3; break; case 0: w = n + 1; break;\n' +
      '                 case 3: w = n + 4; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 0; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swlayout(s32 mode, s32 n);',
    proto: { swlayout: { returnsVoid: true } },
  },
  {
    sym: 'swmulti',
    src:
      'struct Ent { u16 w; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x03003430)\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void swmulti(s32 mode, s32 idx, s32 n){ s32 a = 0, b = 0, c = 0; s32 i = 0;\n' +
      ' do {\n' +
      '  switch (mode) {\n' +
      '   case 0: a = gEnts[idx].w; b = 32 - a; c = 0;                break;\n' +
      '   case 1: a = 32;           b = 0;      c = i << 5;           break;\n' +
      '   case 2: a = gEnts[idx].h; b = 32 - a; c = i * gEnts[idx].h; break;\n' +
      '   case 3: a = gEnts[idx].w; b = 16;     c = i & 32;           break;\n' +
      '  }\n' +
      '  gDma[0] = a; gDma[1] = b; gDma[2] = c;\n' +
      '  i++;\n' +
      ' } while (i < n); }',
    features: ['switch-arms', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void swmulti(s32 mode, s32 idx, s32 n);',
    proto: { swmulti: { returnsVoid: true } },
  },

  // WHERE A LOCAL LIVES — the third thing a store to `[sp,#N]` can be. `value-home` above is about
  // which register or offset a value ends up in; this family is about a local the compiler is not
  // ALLOWED to put in a register at all, because its address escapes. That is not a placement
  // preference, it is an instruction-count difference: every assignment becomes a store and every
  // read a load, and in gcc 2.9 the store also kills CSE of pointer-based loads made before it.
  //
  // Verified by compiling five spellings with agbcc 2.9-arm-000512 (`-O2 -mthumb-interwork
  // -fprologue-bugfix`), destination register-homed vs address-taken:
  //
  //   w = 32; if (e->h <= 31) w = e->h;            register-homed  → ONE ldrh (CSE shares it)
  //   t = e->h; w = 32; if (t <= 31) w = e->h;     register-homed  → ONE ldrh
  //   w = 32; if (e->h <= 31) w = e->h; use(&w);   address-taken   → ONE ldrh (store precedes it)
  //   t = e->h; w = 32; if (t <= 31) w = e->h; use(&w);
  //                                                address-taken   → TWO ldrh, the second after
  //                                                                  the `str` that killed the first
  //
  // So both conditions are needed — the memory home AND a load issued before the store — and
  // together they are what a decompiler has to reproduce to get the byte count right.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc. At its best hand-built spelling (479 against
  // `build/src/gfx.o`, from a 531 baseline) the residual's largest nameable group is exactly this:
  // 15 stores to `[sp,#16..32]` and 5 `ldrh [rN,#18]` in the ROM with no counterpart in the
  // candidate, where the candidate keeps the same values in registers and reads the field once.
  // Forcing the home from the candidate side was measured and is WORSE — `volatile` on the one
  // local costs 29 points (479 → 508), on three costs 23 (→ 502), and moving all three into a
  // local aggregate whose address escapes costs 28 (→ 507) — because those spellings also make
  // every READ a load, which the ROM does not do. So the class is attributed, not closed, and
  // these rows pin the capability that has to exist first.
  //
  // BEFORE ANY OF THAT, asmlift could not LIFT such a function at all: the Thumb frontend refuses a
  // store to `[sp,#N]` that is never reloaded when its lower slots are supplied, on the grounds
  // that it may be a call's outgoing stack argument. For an address-taken local that is a false
  // alarm, and three of these rows carried the decline.
  //
  // That gate is now open for ONE shape and no wider: a frame of exactly one word whose base a
  // bare `mov rD, sp` hands to a callee, and which the caller either WRITES itself or passes at an
  // argument above r0. NOT via callee arity, which this first tried and which cannot license an
  // acceptance — a declared parameter list is a LOWER bound (variadics, multi-word parameters, a
  // hidden struct-return pointer), so `arity <= 4` proves nothing and supplying a TRUE fact turned
  // a correct decline into a call with its stack arguments deleted. What the frame size buys
  // instead is that agbcc emits a bare `mov rD, sp` for a block-copy base too — a by-value struct
  // argument's outgoing area, a struct return's hidden pointer — and all but one of those needs at
  // least two frame words. The exception is a struct return of 4 bytes or fewer that is not
  // INTEGER-LIKE (`{char a,b,c,d;}`, `{short a,b;}`), which agbcc returns in memory through a
  // one-word temp: instruction for instruction an out-parameter call. What rules that out is that
  // the temp is storage the CALLEE owns — written only by the callee, and its pointer is argument
  // 0, always. `stkarg` is the control that keeps the refusal honest.
  //
  // STILL MISSING, and what these rows will pin next: any frame with a second word in it. The
  // object's real extent is inferred from the accesses this function makes, so a wider frame has
  // bytes no model describes, and the refusal stands there. An OUTPUT-only parameter taken at
  // argument 0 is the other gap, and it is not narrowable from the assembly at all: it is
  // instruction-for-instruction the struct return above.
  //
  // Coverage: 0 of the corpus's rows carried this decline. Two real rows do decline with
  // `stack pointer used as data`, both for OTHER reasons that this capability leaves untouched —
  // `pokeemerald:GetMoveTarget:agbcc` (consuming stack call arguments) and
  // `sa3:ProcessOamBuffers:agbcc` (only a plain `mov rD, sp` capture is modelled).
  //
  // agbcc only. The CSE-barrier half is a fact about gcc 2.9's alias handling, established by
  // compiling the pairs above; ido7.1, gcc2.7.2kmc and mwcc_242_81 were NOT measured, and the
  // outgoing-argument shape the refusal models is AAPCS's, so those lanes are left off rather than
  // assumed.
  //
  // m2c compiles none of the three address-taken rows: it renames the slot `unksp0` and never
  // declares it, on the identical `ctx` asmlift receives. It declines `stkarg` outright
  // (`Unable to find stack arg 0x0`), which is the same blocker asmlift names there.
  {
    sym: 'stkaddr',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      'void use(s32 *p);\n' +
      'void stkaddr(u32 i){ s32 w; w = gEnts[i].h; use(&w); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void use(s32 *p); void stkaddr(u32 i);',
    proto: { use: { params: 1, returnsVoid: true }, stkaddr: { returnsVoid: true } },
  },
  {
    sym: 'stkcall',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      's32 four(s32 a, s32 b, s32 c, s32 d);\n' +
      'void use(s32 *p);\n' +
      'void stkcall(u32 i, s32 a, s32 b, s32 c){ s32 w; s32 k = a + b + c;' +
      ' w = gEnts[i].h; k += four(a, b, c, w); use(&w); four(k, k, k, k); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 four(s32 a, s32 b, s32 c, s32 d); void use(s32 *p); void stkcall(u32 i, s32 a, s32 b, s32 c);',
    proto: { four: { params: 4 }, use: { params: 1, returnsVoid: true }, stkcall: { returnsVoid: true } },
  },
  {
    sym: 'stkarg',
    src:
      's32 five(s32 a, s32 b, s32 c, s32 d, s32 e);\n' +
      '#define gOut ((volatile s32 *)0x03003440)\n' +
      'void stkarg(s32 a, s32 b){ *gOut = five(a, b, a + b, a - b, a * b); }',
    features: ['multi-arg'],
    toolchains: ['agbcc'],
    ctx: 's32 five(s32 a, s32 b, s32 c, s32 d, s32 e); void stkarg(s32 a, s32 b);',
    proto: { five: { params: 5 }, stkarg: { returnsVoid: true } },
  },
  {
    sym: 'stkclamp',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      'void use(s32 *p);\n' +
      'void stkclamp(u32 i){ s32 w; u16 t = gEnts[i].h;' +
      ' w = 32; if (t <= 31) { w = gEnts[i].h; } use(&w); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void use(s32 *p); void stkclamp(u32 i);',
    proto: { use: { params: 1, returnsVoid: true }, stkclamp: { returnsVoid: true } },
  },

  // WHERE A CONSTANT OFFSET LIVES. The value-home family above asks which register or slot holds a
  // value; this one asks whether a constant ADDED to it is part of the home or part of each use.
  // A buffer pointer that the source advanced once (`p = alloc(k) + 4`) and a decompiler that
  // re-derives the same address at every site (`*(u8 *)(base + 4 + i)`) describe the same bytes and
  // compile to the same INSTRUCTION COUNT — they differ only in which operand carries the 4, which
  // is why the class shows up as argument mismatches and never as a size difference.
  //
  // Verified by compiling the pair with agbcc 2.9-arm-000512 (`-O2 -mthumb-interwork
  // -fprologue-bugfix`), same body, only the offset moved:
  //
  //   p = (u8 *)getbuf(k) + 4;  sink(p[i]);        putbuf(p - 4);
  //       add r5, r0, #0x4   @ materialised once, then  add r0, r5, r4 / ldrb r0, [r0]
  //       sub r0, r5, #0x4   @ and undone at the free
  //   v = getbuf(k);          sink(*(u8*)(v+4+i)); putbuf(v + 4 - 4);
  //       add r5, r0, #0     @ no offset in the home, then  add r0, r4, r5 / ldrb r0, [r0, #0x4]
  //       add r0, r5, #0     @ and `+4-4` folds away entirely
  //
  // So the compiler moves NEITHER spelling toward the other: the offset stays where the source put
  // it, and getting it wrong costs one operand on every use plus the two ends of the round trip.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, which allocates twice and frees twice through exactly
  // this shape (`thunk_HeapFree(alloc + 4 - 4)`). At the round's best hand-built spelling, homing
  // both `+ 4`s is worth 1 point (475 -> 474 against `build/src/gfx.o`) and removes 3 of the 4 ROM
  // instructions that had no counterpart — `mov r1, #4`, `ldrb r0, [r0, #0]` and `sub r0, #4` go,
  // and `sub r6, #4` stays. Round 2 measured the same edit at +5 on a 531-point rung and
  // excluded it; the sign flips once the switch and the guard placements above it are right, which
  // is why this is recorded as a row and not as an exclusion.
  //
  // `offhome` is the isolate: one call result, one `+ 4`, one indexed read, one free. `offuse` is
  // its control — the same call whose result is read at ONE constant offset and freed unchanged,
  // where folding the offset into the load is what the ROM does and asmlift already MATCHes; a fix
  // that always hoists a constant offset into the home would break it. `offloop` is the real
  // function's shape rather than an isolate, and shows the inconsistency directly: asmlift DOES
  // create `v1 = v0 + 4` when a strength-reduced induction variable forces it, then still writes
  // `v0 + 4 + v2` at the load in the same loop and `v0 + 4 - 4` at the free.
  //
  // agbcc only. The claim is about what THIS compiler does with the two spellings, established by
  // compiling both; ido7.1, gcc2.7.2kmc and mwcc_242_81 were NOT measured, so those lanes are left
  // off rather than assumed.
  //
  // m2c compiles none of the three, on the identical `ctx` asmlift receives: it types the call
  // result as `s32` and then dereferences it (`*(temp_r5 + var_r4)`), and on `offuse` it types the
  // same result as `void *` and reads `temp_r0->unk4`.
  {
    sym: 'offhome',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      'void offhome(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); }' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhome(s32 k, s32 n);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhome: { returnsVoid: true },
    },
  },
  {
    sym: 'offuse',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      'void offuse(s32 k){ u8 *p;' +
      ' p = (u8 *)getbuf(k);' +
      ' sink(p[4]);' +
      ' putbuf(p); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offuse(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offuse: { returnsVoid: true },
    },
  },
  {
    sym: 'offloop',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void offloop(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gDma[0] = (s32)(p + (i << 6));' +
      ' gDma[2] = p[i]; }' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void offloop(s32 k, s32 n);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      offloop: { returnsVoid: true },
    },
  },

  // WHAT ENTERS A LOOP-CARRIED VALUE ON ITS FIRST ITERATION. The `uninit-local` family above
  // already asks what a decompiler does with a local read on a path that never assigns it, and
  // already records the register answer: nothing guards it, and the read becomes a fabricated
  // extra parameter. This family is the LOOP-CARRIED entry of that same question, which those
  // rows do not reach: their undef is decided at an ordinary join, and even where the value is
  // then used in a loop (`uninit_spill`) the phi is not a loop header's. Here it is, so the
  // fabrication lands in the preheader and its register is pinned across the whole loop.
  //
  // A local decided inside a loop body on some but not all paths is a loop-carried phi whose
  // entry operand is UNDEFINED. C spells that by simply not initialising it and agbcc emits no
  // instruction for it. asmlift has an `undef` opcode in the IR but the C backend has to spell it
  // as an expression, so it materialises the entry as a READ: of an uninitialised stack slot, or
  // of a parameter it invented for the purpose. The cost is NOT the read. On `loopfall` agbcc
  // emits no instruction for `v1 = a1;` at all — `a1` arrives in the register `v1` is allocated
  // to and the copy coalesces away. What it costs is the pin: an argument register is occupied
  // across the loop, and the allocation downstream is a different one.
  //
  // Measured on kleod:LoadBGTilemapData:agbcc, both directions:
  //   • REMOVING the five preheader reads from asmlift's own ranked winner (20608 candidates, 0
  //     dropped, `unsigned/flip-branch/flip-join/merge-names/addr-home/expr-home/coalesce-v9-v23/
  //     initfirst/raw-globals`) takes it from 473 to 459 against `build/src/gfx.o` — 14 points of
  //     today's residual.
  //   • ADDING five preheader reads of the same shape to a hand-written C spelling that is 12
  //     points from the ROM takes it to 366. The construct is cheap to carry when everything else is already wrong and a hard
  //     blocker once it is not, which is why both numbers are quoted rather than either alone.
  //
  // `loopfall` is the isolate and `loopset` its control: byte-identical C except for the
  // `else { w = 0; }`. With the else there is no undefined entry and asmlift MATCHes; without it,
  // asmlift emits `void loopfall(u32 a0, u32 a1)` — a second parameter that exists only to be the
  // undef — and opens the loop with `v1 = a1;`. A fix must not disturb `loopset`.
  //
  // MEASURE A FIX ON THE NON-VOLATILE LANE. `loopfall`'s stored winner is the `volatile` one, and
  // deleting the fabricated read from IT scores WORSE — 11 to 12 — because the volatile spelling
  // is compensating elsewhere. The same C without `volatile` goes 14 to 4. The row records 11
  // because 11 is what the ranked pick scores, but a round that ablates the winner and reads the
  // sign off that one number will conclude the capability is not worth building.
  //
  // `armfall` and `armdef` are the same pair at the real function's shape: a switch with no
  // default inside a loop, whose arms decide two locals that the body then uses, so BOTH become
  // loop-carried phis with undefined entries. They are coverage, not isolates. `armdef` is 7
  // points off on its own and NOT all of it is a class already owned: asmlift's C is
  // `if (a0 != 1) { if (a0 >= 1) { if (a0 != 2) …`, which agbcc compiles to the same balanced
  // search the reference uses, and exactly one compare differs (`cmp #1`/`bcc` against
  // `cmp #0`/`beq`). The rest is arm LAYOUT — the reference falls through from case 2 into the
  // shared `ldrh r0,[r3,#0x2]` tail and branches out of case 1, the candidate does the reverse —
  // which is the insert-2/delete-2 half of the breakdown and belongs to no class here yet. What
  // the pair adds over `loopfall` is that the undef survives multi-arm merging: `armdef` carries
  // no preheader read and `armfall` carries two.
  //
  // agbcc only. The claim is about what THIS compiler emits for an uninitialised loop-carried
  // local, established by compiling both spellings of each pair; ido7.1, gcc2.7.2kmc and
  // mwcc_242_81 were NOT measured, so those lanes are left off rather than assumed.
  //
  // NOT `merge-chain`, on `loopfall`/`loopset`. That tag is reserved for arms deciding more than
  // one value; these decide exactly one (`w`) — `i` is the induction variable. The machine floor
  // does not catch it because it counts DECLARED locals and `u32 w, i;` is two, which is the
  // body-vs-declaration gap the floor's own comment calls out. `armfall`/`armdef` DO decide two
  // (`w` and `h`, both computed), and keep it.
  //
  // m2c, on the identical `ctx` asmlift receives, produces compilable C for none of the four, and
  // it reaches the same construct on the two rows that have one. On `armfall` it DECLINES:
  // `M2C_ERROR(/* Read from unset register $r2 */)`, beside its own fabricated entry read
  // `var_r5 = saved_reg_r5;`. On `loopfall` it noncompiles ON that fabrication — the first error
  // is `` `saved_reg_r4' undeclared ``, from its own `var_r4 = saved_reg_r4;`. Both decompilers
  // hit the undefined loop-carried entry, in the same place; only the failure mode differs.
  // The other two errors are not about this family and are not evidence for it: every one of the
  // four also types the address constant as `void *` and reads members off it (`var_r3->unk0`),
  // which is m2c's documented behaviour for a raw address with no struct context; and `armdef`
  // fails FIRST on `` `NULL' undeclared ``, which is a thin-`ctx` artifact — any real project
  // context declares NULL — so that row's classification rests on the `void *` error, not on it.
  {
    sym: 'loopfall',
    src:
      '#define gSrc ((u32 *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void loopfall(u32 n){ u32 w, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' if (gSrc[i] < 8) { w = gSrc[i] >> 2; }' +
      ' gOut[i] = w; } }',
    features: ['uninit-local'],
    toolchains: ['agbcc'],
    ctx: 'void loopfall(u32 n);',
    proto: { loopfall: { returnsVoid: true } },
  },
  {
    sym: 'loopset',
    src:
      '#define gSrc ((u32 *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void loopset(u32 n){ u32 w, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' if (gSrc[i] < 8) { w = gSrc[i] >> 2; } else { w = 0; }' +
      ' gOut[i] = w; } }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void loopset(u32 n);',
    proto: { loopset: { returnsVoid: true } },
  },
  {
    sym: 'armfall',
    src:
      'struct Bg { u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void armfall(u32 mode, u32 n){ u32 w, h, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' switch (mode) {' +
      ' case 0: w = gBgs[i].h; h = 32; break;' +
      ' case 1: w = 32; h = gBgs[i].v; break;' +
      ' case 2: w = gBgs[i].h; h = gBgs[i].v; break; }' +
      ' gOut[i] = w + h; } }',
    features: ['uninit-local', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'void armfall(u32 mode, u32 n);',
    proto: { armfall: { returnsVoid: true } },
  },
  {
    sym: 'armdef',
    src:
      'struct Bg { u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void armdef(u32 mode, u32 n){ u32 w, h, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' switch (mode) {' +
      ' case 0: w = gBgs[i].h; h = 32; break;' +
      ' case 1: w = 32; h = gBgs[i].v; break;' +
      ' case 2: w = gBgs[i].h; h = gBgs[i].v; break;' +
      ' default: w = 0; h = 0; break; }' +
      ' gOut[i] = w + h; } }',
    features: ['merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'void armdef(u32 mode, u32 n);',
    proto: { armdef: { returnsVoid: true } },
  },

  // A STATEMENT WHOSE ONLY EFFECT IS ON THE ALLOCATOR. `gBgs[2].v = gBgs[2].v + 0;` reads a field
  // and writes the same value back. agbcc deletes both the load and the store — the compiled
  // reference contains no `ldrh`/`strh` for it — but NOT its aliasing consequence: while loop
  // optimisation still sees the store, `gBgs[k].dst` is a possibly-aliased memory read and stays
  // inside the loop. Delete the statement from the source and agbcc hoists that load to the
  // preheader and strength-reduces the store into `stmia r3!, {r0}` — a different loop. Verified
  // by compiling the pair.
  //
  // asmlift recovers the re-read correctly (its candidate loads through the base every iteration)
  // and drops the no-op statement, which is the right thing to do with a statement that emits
  // nothing. The row is here because the residual that leaves is not nothing: 8 rows, and every
  // one of them is a register NAME. The breakdown is `replace 2, argMismatch 6` with insert and
  // delete both zero — same opcodes, same operand structure, same order, so nothing here is a
  // missing or extra instruction. It is two renamings: the base is r5 in the reference and r4 in
  // the candidate (which is the `push {r4, r5, lr}` / `push {r4, lr}` pair, and the pop, and the
  // 2 replaces), and r0 and r1 are exchanged through the whole body. That the *deleted* statement
  // is what the 8 turns on IS established, by the control: `rereadctl` is the same C with the
  // statement gone and asmlift MATCHes it. What is not established is WHY — re-inserting the
  // statement into asmlift's raw-address spelling makes agbcc keep the `ldrh`/`strh` (the
  // struct-typed reference spelling is what lets it delete them), so no candidate reproduces the
  // reference's combination. The row records the residual and its size, not a mechanism.
  //
  // `value-home` and not `read-once`: read-once is about a value read once above a branch and
  // re-read per arm, and this row has no branch and no arm — the load sits inside the loop in the
  // reference AND in the candidate. A zero insert/delete breakdown over renamed registers is
  // value-home's definition exactly.
  //
  // `rereadctl` is the control: the same C with the no-op statement gone. It keeps the compiler
  // claim above under the harness instead of in a commit message, and it MATCHes — so the pair
  // brackets the gap exactly, 0 without the statement and 8 with it.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, where the second decomp's 98.24% attempt writes the
  // same construct as `gBgInfo[2].vLength += 0;` and marks it `// FAKE`. It is worth 178 points
  // there: deleting that one statement takes the spelling from 12 to 190 against the ROM object.
  //
  // agbcc only, for the same reason as the family above: the deletion-but-not-the-alias behaviour
  // is this compiler's, established by compiling both spellings.
  {
    sym: 'reread',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      'void reread(u32 k, u32 n){ u32 i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gBgs[2].v = gBgs[2].v + 0;' +
      ' gBgs[k].dst[i] = i << 6; } }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void reread(u32 k, u32 n);',
    proto: { reread: { returnsVoid: true } },
  },
  {
    sym: 'rereadctl',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      'void rereadctl(u32 k, u32 n){ u32 i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gBgs[k].dst[i] = i << 6; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void rereadctl(u32 k, u32 n);',
    proto: { rereadctl: { returnsVoid: true } },
  },

  // WHICH of several numeric bases gets the pointer local. The `dma_*` rows above ask whether a
  // reused absolute address is spelled as one base local at all; this pair asks the question a
  // function with SEVERAL of them poses, which those rows cannot: the answer is per base, and
  // asmlift's is per function.
  //
  // `l3/basecse.ts` hoists a base indexed at 2+ sites into a typed pointer local, gated by
  // BASECSE_GATES. Two of those gates — `loop` (a function-top hoist of a loop base forces a
  // callee-saved register) and `repeated-const-offset` (a fixed offset touched twice is a scalar
  // RMW the compiler re-materializes) — are exactly wrong for an MMIO poll, so rank.ts's
  // `/livebase` lever re-runs the pass with both ablated, leaving only `single-use`. That lever
  // is ALL-OR-NOTHING over bases: `hoistReusedGlobalBases` hoists every key the gate list admits,
  // and there is no candidate for a proper subset. `/volatile` (l3/volatileptr.ts) does enumerate
  // subsets — but `volatileSubsetCandidates` returns `[]` outside `2 <= eligible <= 3`, so the
  // subset door is shut on exactly the functions that have several bases.
  //
  // `mixpoll` is the isolate: one DMA register file that must be a bound `volatile` local, and
  // three IWRAM scalars that must stay inline absolute derefs. The ROM's own C is the reference,
  // and hoisting the three IWRAM cells is what costs — measured by hand-editing asmlift's own
  // winner one clause at a time against the same object:
  //     all four bound, all four volatile (asmlift's winner) .................... 11
  //     all four bound, only the DMA base volatile .............................. 11
  //     all four bound, none volatile .......................................... 27
  //     ONLY the DMA base bound, volatile, the three IWRAM cells inline .......... 0  ← MATCH
  //     only the DMA base bound, NOT volatile ................................... 21
  // So the 11 is the hoist alone (qualifying the IWRAM cells `volatile` on top of the wrong hoist
  // is worth 0 here), and `volatile` on the base that needs it is worth 21 — the lever pair is
  // right about both bases and wrong about which ones. A base census over all 12 enumerated
  // candidates: every one binds either 0 or all 4 numeric bases, and marks 0 or 4 of them
  // `volatile`. The matching spelling is in none of them.
  //
  // `onepoll` is the control — byte-identical C with the three IWRAM statements deleted. One base,
  // no selectivity question, and `/livebase/volatile` MATCHes it. So the pair brackets the gap
  // exactly: 0 with one base, 11 with four, same lever, same poll, same loop.
  //
  // The loop is spelled `i = 0; do … while` rather than `for` deliberately: a `for` puts the
  // family below's zero-trip guard into the same row, and this row is about the bases. With the
  // `for` spelling the same shape scores 15, of which 11 is these bases and 4 is that guard
  // (verified by composing both fixes by hand: 15 → 4 → 0).
  //
  // Cut from kleod:LoadBGTilemapData:agbcc. A base census over its whole 20608-candidate
  // enumeration returns four shapes and no others: 13440 bind nothing, 1024 bind 0x03003430 alone
  // (the default pass's own single admission), 3072 bind all five of 0x03003430 / 0x03003478 /
  // 0x0300347A / 0x030034A0 (IWRAM) and 0x040000D4 (the DMA register file) plain, and 3072 bind
  // those same five all `volatile`. Not one binds the DMA base alone, and five eligible locals is
  // also why no `/volatile-<name>` subset label exists there: the cap is 3.
  //
  // agbcc only. The claim is about what THIS compiler does with the two spellings, established by
  // compiling both; the poll declines on ido7.1/gcc2.7.2kmc's branch-likely lift link exactly as
  // `dma_wait` records, and mwcc_242_81 stays off per the `hipress` hazard policy.
  {
    sym: 'mixpoll',
    src:
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      'void mixpoll(s32 n){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i; i = 0;' +
      ' do { gRows = gRows + 1; gCols = gCols + 2; gTiles = gTiles + 3;' +
      ' dma[0] = 0x03004000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} i = i + 1; } while (i < n); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void mixpoll(s32 n);',
    proto: { mixpoll: { returnsVoid: true } },
  },
  {
    sym: 'onepoll',
    src:
      'void onepoll(s32 n){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i; i = 0;' +
      ' do { dma[0] = 0x03004000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} i = i + 1; } while (i < n); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void onepoll(s32 n);',
    proto: { onepoll: { returnsVoid: true } },
  },

  // WHO OWNS THE FIRST STATEMENT OF A ZERO-TRIP GUARD'S ARM. `for (i = 0; i < n; i++)` compiles
  // with the init ABOVE the test, so the guard compares the COUNTER against the bound; the same
  // loop written `if (0 < n) { i = 0; do … }` compiles with the init behind the branch and the
  // guard against the CONSTANT. Both spellings lift to the same IR — a constant has no position —
  // so `l3/initfirst.ts` emits the init-first sibling as `/initfirst` and the differ referees.
  // Verified by compiling the four-way pair with this agbcc (`-O2 -fhex-asm -fprologue-bugfix`):
  //     s32 counter, `for`   :  mov r4, #0x0 / cmp r4, r5 / bge
  //     s32 counter, guard   :                 cmp r5, #0 / ble
  //     u32 counter, `for`   :  mov r4, #0x0 / cmp r4, r5 / bcs
  //     u32 counter, guard   :                 cmp r5, #0 / beq
  // — the operand pair always changes, and on an unsigned bound the branch OPCODE changes too
  // (fold-const rewrites the unsigned `> 0` to `!= 0`). Two instructions and a condition code.
  //
  // The re-spelling has a precondition the rest of the pipeline can take away from it: the guarded
  // arm's FIRST statement must be the init `v = X`, and the guard's other side must be X ITSELF
  // (`exprEquals(cond.l, init.value)`). `unsguard` is the row where a sibling lever takes it away.
  // Its counter is unsigned, so the match needs `/uns-cmp` (structure.ts unsignedCompareSpelling)
  // to spell the loop compares unsigned — and that axis renders the guard's constant side as
  // `(u32)0`, which is no longer the init's `0`. Across all 30 enumerated candidates, NOT ONE
  // carries `/uns-cmp` and `/initfirst` together; the two spellings the match needs are in
  // different candidates:
  //     unsigned/livebase/volatile/initfirst  (asmlift's winner) ....  2
  //     unsigned/uns-cmp/livebase/volatile ..........................  5
  //     the same candidate with the guard re-spelled by hand .........  0  ← MATCH
  // Attributed by ABLATION, not by reading: teaching initfirst's side match to look through a cast
  // makes `unsigned/uns-cmp/livebase/volatile/initfirst` appear (36 candidates, up from 30) and it
  // scores 0. The blocker is the cast, not a hoist — `/uns-cmp` moves no statement.
  //
  // `signguard` is the control, and it differs by ONE token: `s32 i` for `u32 i`. Nothing else in
  // the C changes, the halving keeps its `(u32)` cast so it stays an `lsr` on both, and asmlift
  // MATCHes it with `/initfirst` in the label. So the pair brackets the gap exactly: the guard
  // re-spelling works, and it is the unsignedness that removes it.
  //
  // A SECOND blocker sits at the same precondition and has NO row: `/expr-home` can land its hoist
  // at the head of the guarded arm (`if (0 < n) { v0 = 128 << 24; v1 = 0; do …`), and then `then[0]`
  // is not the init. It reproduces synthetically — on a probe of this shape with a loop-invariant
  // constant used twice, every `/expr-home` label lacks an `/initfirst` sibling and hand-composing
  // them improves 31 → 26 — but on every shape tried the `/expr-home` branch scores far behind the
  // winner, so no row demands it and none was written. What would earn one: a target whose ranked
  // winner carries `/expr-home` with the hoist INSIDE the guard. (`sizebound:agbcc` carries both
  // `/expr-home` and `/initfirst`, because there the homed value is parameter-derived and agbcc
  // materialises it before the guard — that composition is not the broken one.)
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, whose L1 guard is `movs r3, #0 / … / cmp r3, r2 / bge`
  // in the ROM and `if (0 < *(u16 *)50345082)` in the ranked winner.
  //
  // agbcc only, as the poll rows above: `ucmp` already carries the compare-polarity axis on all
  // four toolchains, and what this pair adds is its interaction with a guarded do-while that the
  // GBA DMA poll is what produces here.
  //
  // m2c compiles neither, on the identical `ctx` asmlift receives, and for the reason every
  // raw-address row here records rather than for anything in this family: it types the address
  // constant as `void *` and reads members off it (`(void *)0x040000D4->unk0`). It does reach the
  // construct — on `unsguard` it emits `var_r1 = 0;` ABOVE the guard and then tests
  // `if (temp_r2 > 0U)`, i.e. the init placement right and the compared operand pair wrong.
  {
    sym: 'unsguard',
    src:
      'void unsguard(s32 t){ volatile s32 *dma = (volatile s32 *)0x040000d4; u32 i;' +
      ' for (i = 0; i < 16 << t; i++){' +
      ' dma[0] = 0x03002000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['guard-init', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'void unsguard(s32 t);',
    proto: { unsguard: { returnsVoid: true } },
  },
  {
    sym: 'signguard',
    src:
      'void signguard(s32 t){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < 16 << t; i++){' +
      ' dma[0] = 0x03002000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['guard-init'],
    toolchains: ['agbcc'],
    ctx: 'void signguard(s32 t);',
    proto: { signguard: { returnsVoid: true } },
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
