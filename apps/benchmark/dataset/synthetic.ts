// Tier A — synthetic dataset. Functions I author to exercise COMMON decompilation features with
// known ground truth, spread across the four toolchains. Deliberately breadth-first over the idioms
// that dominate real game code (arithmetic, bitwise, compare/logic, width casts, memory, structs,
// arrays, loops, calls) rather than exotic constructs — the anti-overfitting goal.
//
// `toolchains` lists which toolchains to run each function on. MIPS-IDO is steered away from calls
// (its PIC codegen makes external calls unfriendly to both decompilers).
// C++ runs on mwcc_242_81 only (the `.cp` frontend). `ctx` is the m2c --context and `proto` feeds
// asmlift the same info. For almost every row that is prototypes only — no struct layouts, so both
// decompilers must RECOVER structure. THE EXCEPTION IS A ROW THAT CARRIES `symbols` (see below):
// there the map's declarations are rendered into `ctx` too, by `src/cases/synthetic.ts`, so the
// two channels still carry the same facts. What a row measures is its SOURCE SPELLING, which is in
// neither channel.
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';

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
  /** A SYMBOL MAP for this row, the same value the real tier feeds asmlift off a project
   *  manifest (`src/cases/real.ts`). Synthetic rows carry none by default and that is not a
   *  neutral default: `/no-bitfield`, `/no-ptr-elem` and `/raw-globals` are enumerated only when
   *  the map answers, so a map-less tier is structurally incapable of exercising them and their
   *  zero winning labels measure the CORPUS rather than the capability. A row that sets this
   *  hand-writes the same `SymbolInfo` shape the ELF provider emits.
   *
   *  SETTING THIS ALSO FEEDS m2c. The map reaches asmlift alone, so a row that set it and stopped
   *  would be an information asymmetry — and a measured one, not a theoretical: told only its
   *  prototype, m2c emits `extern ? gBgTilemapBufs;` on `sbscope` and the row publishes a DECLINE
   *  that the declaration alone dissolves. `src/cases/synthetic.ts` therefore RENDERS this map
   *  into the row's `ctx` through core's own declaration renderer, and `authored-facts.test.ts`
   *  holds the two equal FACT BY FACT — every symbol, every declared member, every inner array
   *  extent. BY FACT AND NOT BY SYMBOL NAME: a name-level check passes with every gate green on a
   *  ctx the shape fields were stripped out of. Add a fact here and m2c is told it. The single
   *  exception is an array's OUTERMOST extent, left unsized by `declare.ts`'s own rule and measured
   *  on `sbscope` to change m2c's output not at all. */
  symbols?: SymbolMap;
}

const ALL: ToolchainId[] = ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'];
const CALL: ToolchainId[] = ['agbcc', 'gcc2.7.2kmc', 'mwcc_242_81']; // IDO PIC-unfriendly for calls

// The map the `/no-ptr-elem` row below is fed: a struct global with a SIZED pointer member
// (`u16 *pMap`), which is the exact predicate `fnHasSizedPtrFields` enumerates the axis on.
const BGPTRS_MAP: SymbolMap = new Map([
  [
    0x03004790,
    [
      {
        name: 'gBgPtrs',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'BgPtrs',
        size: 8,
        layout: [
          { name: 'pMap', offset: 0, size: 4, pointer: true, pointeeSize: 2, pointeeSigned: false },
          { name: 'pad', offset: 4, size: 4, signed: false },
        ],
      },
    ],
  ],
]);

// The map the `/scopebase` row below is fed: a rank-2 u16 array global, the real
// `gBgTilemapBufs` shape read off a project ELF. The RANK is the load-bearing part — with `dims`
// the access renders as the bare `gBgTilemapBufs[0][i]`, whose base is a `var` that
// `l3/basecse.ts`'s `isHoistableBase` cannot see, which is exactly the eligibility hole
// `l3/scopebase.ts` was built for.
const TILEMAP_MAP: SymbolMap = new Map([
  [
    0x03000900,
    [
      {
        name: 'gBgTilemapBufs',
        kind: 'data' as const,
        declared: true,
        shape: 'array' as const,
        elemSize: 2,
        elemSigned: false,
        size: 8192,
        dims: [4, 1024],
      },
    ],
  ],
]);

// The map the two `/no-bitfield` rows below are fed — the same `SymbolInfo` shape the ELF
// provider emits for a struct global whose first u16 packs three unsigned bitfields (the kleod
// Unk_03005220 layout), with a plain u32 following at byte 4. `bfwordread`/`bfwordwrite` read and
// write the third field, `dreamStones`, at bits [11:5].
const PACKED_MAP: SymbolMap = new Map([
  [
    0x03005220,
    [
      {
        name: 'gPacked',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'Packed',
        size: 8,
        layout: [
          { name: 'hearts', offset: 0, size: 1, signed: false, bitWidth: 2, bitOffset: 0 },
          { name: 'stars', offset: 0, size: 1, signed: false, bitWidth: 3, bitOffset: 2 },
          { name: 'dreamStones', offset: 0, size: 2, signed: false, bitWidth: 7, bitOffset: 5 },
          { name: 'unk4', offset: 4, size: 4, signed: false },
        ],
      },
    ],
  ],
]);

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
    sym: 'umodv',
    src: 'unsigned umodv(unsigned a,unsigned b){ return a%b; }',
    features: ['arithmetic', 'mod-reg', 'unsigned'],
    toolchains: ALL,
  },
  // The remainder written OUT, as a source-level subtract-multiply-divide. It is not a `%` and must
  // not be respelled as one: on an ISA that synthesizes `%` from exactly these three instructions,
  // the two spellings differ by the multiply's operand order.
  {
    sym: 'modb',
    src: 'int modb(int a,int b){ return a - b*(a/b); }',
    features: ['arithmetic', 'div-reg', 'signed'],
    toolchains: ALL,
  },
  // The remainder whose two operands are CALLS, in the order the machine runs them. Folding the
  // written-out idiom to `%` would drop both from two uses to one and inline them into the one
  // expression, where C leaves their order unspecified and mwcc runs the RIGHT one first — so the
  // fold must refuse here and spell the decomposition out, which names them and states the order.
  // This row is that refusal's price: it is the shape the guard costs, published rather than argued.
  {
    sym: 'modseq',
    src: 'int lo(void);\nint hi(void);\nint modseq(void){ int a = lo(); return a % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: CALL,
    ctx: 'int lo(void); int hi(void);',
    proto: { lo: { params: 0 }, hi: { params: 0 } },
  },
  // `modseq` one PURE op deeper. The structurer inlines through single-use pure ops, so what lands
  // at an operand of the invented `%` is the operand's whole CONE — a `+ 1` between the call and the
  // fold does not make the call stay put. Sampling the refusal only where the effect is the operand's
  // immediate def cannot see that, which is what this row exists to stop.
  {
    sym: 'modcone',
    src: 'int lo(void);\nint hi(void);\nint modcone(void){ int a = lo() + 1; return a % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: CALL,
    ctx: 'int lo(void); int hi(void);',
    proto: { lo: { params: 0 }, hi: { params: 0 } },
  },
  // The same question asked of a memory READ rather than a second call: the read answers whichever
  // stores ran before it, and the call it would be hoisted over is one asmlift hands the pointer to.
  // Two reads would commute; a read against a call does not.
  //
  // Its agbcc cell (8) is a KNOWN, pre-existing silent de-sequencing, not a scoring curiosity —
  // DO NOT close it by making the spelling match. agbcc reaches `smod` through raise/softdiv.ts
  // (`bl __modsi3`), which invents the `%` exactly as the PPC fold does and carries no guard at
  // all: asmlift emits `*a0 % (s32)hi()` and agbcc emits `bl hi | ldr r0,[r4]` against the
  // reference's `ldr r4,[r0] | bl hi`. Proved pre-existing by decompiling the same asm with the
  // hwmod patterns removed — byte-identical source. Guarding softdiv re-prices the largest tier.
  {
    sym: 'modread',
    src: 'int hi(void);\nint modread(int *p){ int x = *p; return x % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed', 'pointer'],
    toolchains: CALL,
    ctx: 'int hi(void);',
    proto: { hi: { params: 0 } },
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
  //   • an ARGUMENT register ⇒ silent: nothing guards it and the read becomes a fabricated extra
  //     parameter. MEASURED: both agbcc rows byte-MATCH anyway, because the invented parameter
  //     lands in the register the local was allocated to — `uninit_sw(s32 a0, s32 a1, s32 a2)` for
  //     a two-argument function, and `uninit_join(s32 a0, s32 a1)` for a one-argument one. A
  //     trailing parameter nothing reads costs nothing on this ABI. That is a fidelity gap the byte
  //     score cannot see, and the reason these rows are worth keeping green: they are the rows
  //     where the remaining half of `undef` must change the C and NOT the bytes. Both locals here
  //     land in r1/r2, so both rows sit on that half.
  //   • a register the ABI does NOT pass arguments in, which the prologue SAVED ⇒ an `undef`
  //     (target.nonArgRegs against thumb.ts's `savedRegs`). A caller cannot hand a value over in
  //     one, and the compiler homes a local there only after saving it, so the fabrication has no
  //     premise and the signature stops growing. That is what closed `loopfall`, below.
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
  // (`preupdate_exit`), and a CALL in one (`preupdate_exit_call`, and `_wrapup_reent`).
  //
  // So the three EXIT rows are the three tiers, not three copies: a fix for the pure tier closes
  // the real bucket, and the other two are what say it did not overreach. The CALL tier used to
  // stop one guard later still, on "a post-loop value inlines a 'call' from inside the loop"; it
  // no longer does. `structure/analysis.ts` materializes any call whose value rides a branch edge
  // — the placement that guard existed to refuse — so `preupdate_exit_call` now RECOVERS, at 2,
  // with `cb` inside the loop where the asm calls it. What still reaches that guard is an
  // `opaque`, the other member of `REPEATED_EFFECT`, for which no such rule exists. The pure row puts a STORE in the body AHEAD of the def, which is the
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
      "an exiting edge carrying a CALL's result computed from the pre-update loop variable. Authored " +
      'as a second refusal behind the pre-update one; that second refusal has since been removed at ' +
      'its cause (a call feeding a branch edge is materialized where the asm ran it), so the row ' +
      'scores instead of declining and it is now the pre-update link alone that it measures',
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
  // two sizes, they exercise BOTH paths. MEASURED on the primary (unranked) output: `ifand_near`
  // lands on the source's own `a != 0 && b != 0` and matches, while `ifand_far` lands on the
  // `a == 0 || b == 0` dual and misses by 262. The distance is what decides which, so the
  // orientation is a per-SITE fact and the per-function joined-sense default is a coin flip on
  // this family whichever way it is set.
  //
  // `ifor_near` is the ORIENTATION control, and it lands on the dual too (`a == 0 && b == 0`, 20).
  // So the gap is not "this shape is unrecoverable" but "one of the fold's two arms emits the
  // spelling the compiler did not" — and a row that could falsify the claim is worth more than a
  // third that restates it. What referees it on the RANKED path is `/flip-join`, which emits the
  // other joined sense: all three rows match there, two of them on the axis. There is deliberately
  // no `ifor_far`: measured, a `||` matches at BOTH distances.
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
  // cross-jumps back together, so a test pins that orientation, not this row; and every row reads
  // `noncompile` for m2c on an unrelated pointer-spelling defect of its own. All five rows match
  // on the ranked path, so `bench regression` holds every one — but only against a LOST match, and
  // what these rows are really about is WHICH ORIENTATION won. That is
  // packages/cli/test/matching/shortcircuit-branch.test.ts, which asserts the connective itself
  // and runs with the benchmark refresh rather than on every PR.
  {
    sym: 'ifand_near',
    src: 'int ifand_near(int a, int b, int *p, int *q){ if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int ifand_near(int,int,int*,int*);',
    note:
      "at this distance the fold lands on the source's own `&&`, so asmlift matches at the " +
      'default joined sense with no axis. m2c prints the same orientation, and its output is ' +
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
      'a long-branch trampoline on each edge. The fold looks through them, and the inverted ' +
      "polarity lands this orientation on the `||` dual — so here the source's own `&&` is " +
      "`/flip-join`'s spelling, the mirror of `ifand_near`. The SCORE cannot police that: the " +
      'un-folded spelling tail-duplicates the else arm and agbcc cross-jumps the copies back ' +
      'together, so this row read MATCH before the shape was recovered too — what the orientation ' +
      'is pinned by is a test, not this number',
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
  // addresses so the rows stay self-contained. (That was once justified as "a candidate could not
  // declare an extern global"; the GLOBAL ARRAY SHAPE family far below REFUTES that — asmlift
  // synthesizes the declaration off the target asm and such rows compile and score. Self-contained
  // absolute addresses remain the right choice HERE, because these rows are about where a value
  // lives, not about how a base is spelled, and a named symbol would add a second moving part.)
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
  //
  // WHAT THESE ROWS DO NOT PIN, recorded here because no synthetic row can. `dma_wait:agbcc`
  // MATCHes with candidate label `unsigned/livebase/volatile`, so the volatile-base capability
  // exists and that row pins it. What is NOT pinned is that the same capability is EXCLUDED once
  // the device base is spelled as a NAMED symbol rather than a numeric address. Measured on
  // kleod:LoadBGTilemapData with the project's symbol map on: of the 66,816 ranked candidates
  // 14,592 spell globals by name and 52,224 by raw address; 18,432 of the raw ones carry a
  // `/volatile*` label and ZERO of the named ones do — counted both from the run's `[score]`
  // labels and from the 66,816 captured candidate `.c` files, 18,432 of which declare a volatile
  // pointer local, none in the named basin. Instrumented rather than read: `l3/volatileptr.ts`'s
  // eligibility prints `verdict=NOT-numericFed` for every pointer local there, and the FIRST veto
  // is `numericFed` — `rematerializableAddress` (l3/ast.ts:484) reaches `default: ok = false`
  // (:497) on an `addr` node, so `(s32 *)&REG_DMA3SAD` is not a rematerializable feed.
  // `feedsSymbolAddress` (volatileptr.ts:136) is a real second veto, but ablating it ALONE moves
  // no candidate; a lever has to lift both. A synthetic row cannot express any of that:
  // `SynthSpec` at the top of this file has no map or ELF field, only the real-tier manifests
  // carry one, and with no map asmlift never emits `&gSym`, so the naming cannot happen here at
  // all (same minimized shape with the map off: 36 candidates, 8 of them carrying `/volatile`).
  // That is narrower than "the axis is always available": both vetoes test the NODE KIND, and
  // `laddr` mints an `addr` node for a proved frame-object address with no map in sight
  // (`structure/structure.ts`), so a pointer local fed `&aLocal` on one path is refused by the
  // same two clauses. No row reaches that either — both probes of it decline first in the Thumb
  // frontend, on the address-taken stack local. The row this wants is REAL-tier, on a project
  // that already builds a symbol map.
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
  // The RETURN-VALUE home, and the third of `l3/regspell.ts`'s three tails. A materialized phi
  // re-spells as a copy plus an in-place update (R1: `j = i; w = j; if (w >= 8) w = w - 8;`), and
  // the assign-back that lands the result in a local before the `return` then has TWO spellings —
  // R1's now-dead value var (`/regcopy-ret`) or a fresh one (`/regcopy-ret-fresh`). Which one the
  // source used is not derivable from the asm, so both are ranked. The reuse side is already
  // pinned by real rows (`kleod:MultiplyQ8`/`MultiplyQ4`, `pokeemerald:MathUtil_Mul16`, all agbcc,
  // where the fresh tail scores 3 against the reuse tail's 0); this row is the fresh side, which
  // no corpus row exercised.
  // WHY ido7.1 ALONE. The three spellings are three different objects only on ido: measured on
  // this row's own fan with `ASMLIFT_CANDCACHE=0`, `/regcopy-ret-fresh` scores 0 against 2 for the
  // tail-less base spelling and 5 for the reused tail, and it is the ONLY candidate of the 7 that
  // matches. agbcc, gcc2.7.2kmc and mwcc_242_81 all fold the fresh assign-back away, so the same
  // source matches there on the base `/regcopy` spelling and the row would measure nothing.
  {
    sym: 'ringread',
    src: 'int ringread(int *p,int i){ int j; int r; j = i; if (j >= 8) j -= 8; r = p[j] + i; return r; }',
    features: ['value-home', 'array', 'variable-index', 'branch'],
    toolchains: ['ido7.1'],
    ctx: 'int ringread(int *p, int i);',
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
  // against the reference compile. All five MATCH today, so the block is coverage: each holds a
  // composition that the sibling levers close only jointly, and a regression in any one of them
  // is a lever that stopped composing. `dmafield` fuses fieldbase's neighbor cells with
  // dma_wait's poll block in one function, so it needs `/nearbase` and `/livebase` + the poll
  // spelling to arrive in the SAME candidate. `armhomes` runs the SAME hot DMA loop in both arms
  // of an `if`, and the reference homes the mask and the loop invariants PER ARM, re-materializing
  // the mask again for each poll — per-region homes of a MASK, which is a placement question and
  // not the base-COUNT question the `dmascope` family below measures. `nestinit` is sizehome's
  // exact shape nested inside a guard, so the init-first re-spelling has to reach a statement list
  // below the top level. sizehome/maskhome are the single-loop controls.
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
  // self-contained. (Not because a named global is impossible — the GLOBAL ARRAY SHAPE family far
  // below relocates against one and scores — but because these rows isolate a re-read, and the
  // base spelling would be a second moving part.)
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
  // `offhome` is the isolate: one call result, one `+ 4`, one indexed read, one free — and it is
  // what pins `/expr-home`'s scope (structure/analysis.ts loopSharedConsumers) at ONE in-loop
  // consumer plus one anywhere, since the bias is read once inside the loop and once at the free.
  // `offuse` is its control — the same call whose result is read at ONE constant offset and freed
  // unchanged, where folding the offset into the load is what the ROM does and asmlift MATCHes; a
  // rule that always hoisted a constant offset into the home would break it, and the loop gate is
  // why this one cannot (`offuse` has no loop, so the axis is not even enumerated). `offloop` is
  // the real function's shape rather than an isolate: the same bias with a strength-reduced
  // induction variable also riding it. Its residual is not the bias — it is the IV's init copy
  // sitting above the zero-trip guard where the ROM has it below, which is the guard-placement
  // family, not this one.
  //
  // agbcc only. The claim is about what THIS compiler does with the two spellings, established by
  // compiling both; ido7.1, gcc2.7.2kmc and mwcc_242_81 were NOT measured, so those lanes are left
  // off rather than assumed.
  //
  // m2c compiles none of the three, on the identical `ctx` asmlift receives: it types the call
  // result as `s32` and then dereferences it (`*(temp_r5 + var_r4)`), and on `offuse` it types the
  // same result as `void *` and reads `temp_r0->unk4`. It noncompiles the two `offhi_` rows too,
  // there on `(void *)0x03000004->unk0` — the raw-address rendering, not context withheld — and
  // its output is the neat control on this axis: it writes the SAME fused initializer for both
  // (`temp_r9 = getbuf(k) + 4;` on the split target, `temp_sl = getbuf(k) + 4;` on the fused one),
  // naming the register home it read and folding the addend either way.
  //
  // THE SAME CONSTANT, ONE REGISTER CLASS HIGHER — `offhi_split` / `offhi_fused`. The three rows
  // above all sit entirely in LO_REGS (`grep -c "r8\|r9\|sl\|fp"` over `offhome`'s own compiled
  // reference: 0), and there the two spellings differ only in WHICH operand carries the 4. Raise
  // the register pressure until the buffer pointer's home is a HIGH register and a THIRD fact
  // appears, which those rows structurally cannot see: agbcc's `addsi3` (agbcc/gcc/thumb.md:595)
  // offers an immediate op2 only on the alternatives that constrain op0 to `l` (LO_REGS); its two
  // high-register alternatives (`*h`, `*r`) require op2 to be a REGISTER. So `hi = call(); hi += 4;`
  // must become `mov rH, r0 / mov rL, #4 / add rH, rH, rL`, while `hi = call() + 4;` does the add
  // while the result is still in `r0`. Compiled pair, this agbcc, four values kept live across the
  // loop so the home lands above r7 and nothing spills:
  //     p = getbuf(k); p = p + 4;   ->  bl getbuf / mov r9, r0 / mov r0, #0x4 / add r9, r9, r0
  //     p = getbuf(k) + 4;          ->  bl getbuf / add r0, r0, #0x4 / mov sl, r0
  // The ROM this was cut from writes the first shape (`3414: mov r8, r0` / `3416: movs r1, #4` /
  // `3418: add r8, r1`) and asmlift writes the second — so reproducing `mov/movs/add` here is a
  // GAIN, not the regression the shape's read-back cousin looks like.
  //
  // `offhi_fused` is the HIGH-register control and asmlift MATCHes it. `offhi_split` is the gap,
  // and its endpoint is proved rather than argued: asmlift's OWN emitted C for it scores 12, and
  // that same C with the one initializer split in two (`v0 = getbuf(a0); v0 = v0 + 4;`) scores 0,
  // byte-exact. The whole 12 is one statement, and that byte-exactness is also what establishes
  // NO REACH for the row without a census: a candidate carrying the split spelling would have
  // scored 0 and the row would read MATCH, not diff:12.
  // The shape of the fan is a separate observation and belongs to a STANDALONE probe of the same
  // asm rather than to this row — that probe was run without a `ctx`, so it recovered a
  // two-parameter `void offhi_split(s32 a0, s32 a1)` where the row declares one parameter, and
  // the two fans are not proven identical. In it, of 12 candidates 6 spell `v0 = getbuf(a0) + 4;`
  // and 6 spell `v0 = getbuf(a0);` with the bias re-derived at every use (`*(u8 *)(v0 + 4 + v6)`,
  // `putbuf(v0 + 4 - 4)`). Those are the two points of the `/expr-home` lattice `offhome` and
  // `offuse` bracket, and neither of them is the split — a home that receives the RAW call result
  // and takes the addend in a following statement is a third point the axis does not have.
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

  {
    sym: 'offhi_split',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      '#define gW ((volatile s32 *)0x03000000)\n' +
      'void offhi_split(s32 k){ u8 *p; s32 i, n, a, b, c, d;' +
      ' p = (u8 *)getbuf(k); p = p + 4;' +
      ' n = gW[0]; a = gW[1]; b = gW[2]; c = gW[3]; d = gW[4];' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); sink(a); sink(b); sink(c); sink(d); }' +
      ' sink(a); sink(b); sink(c); sink(d);' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhi_split(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhi_split: { params: ['s32'], returnsVoid: true },
    },
  },
  {
    sym: 'offhi_fused',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      '#define gW ((volatile s32 *)0x03000000)\n' +
      'void offhi_fused(s32 k){ u8 *p; s32 i, n, a, b, c, d;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' n = gW[0]; a = gW[1]; b = gW[2]; c = gW[3]; d = gW[4];' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); sink(a); sink(b); sink(c); sink(d); }' +
      ' sink(a); sink(b); sink(c); sink(d);' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhi_fused(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhi_fused: { params: ['s32'], returnsVoid: true },
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
  // instruction for it. asmlift used to materialise the entry as a READ — of an uninitialised
  // stack slot, or of a parameter it invented for the purpose. The cost was NOT the read: on
  // `loopfall` agbcc emits no instruction for `v1 = a1;` at all, since `a1` arrives in the
  // register `v1` is allocated to and the copy coalesces away. What it cost was the pin — a
  // register occupied across the loop, and a different allocation downstream.
  //
  // Two rules close it, and each covers one of the two ways the entry got materialised. An `undef`
  // reaching a merge as an EDGE ARGUMENT emits no copy (structure.ts undefCarriesNothing), and a
  // saved register the ABI does not pass arguments in is an `undef` rather than a parameter in the
  // first place (target.nonArgRegs, frontend/ssa.ts). `loopfall` MATCHes on both together.
  //
  // WHAT IS LEFT is the case neither rule can reach: a def-less read of an ARGUMENT register past
  // the function's real arity. Nothing in the asm separates "argument 3" from "a local agbcc homed
  // in r2", so `armfall` still declares four parameters for a two-parameter source and still opens
  // its loop with `v3 = a2;`. That is an arity question, not an initialisation one.
  //
  // Measured on kleod:LoadBGTilemapData:agbcc, both directions. PRICE CORRECTED: the ADDING number
  // was first taken against a reference source that carries three register-allocation coercions
  // (statements with no semantic content, marked `// FAKE?` there). Deleting them halves it, so
  // both endpoints are quoted:
  //   • REMOVING the five preheader reads from asmlift's own ranked winner (20608 candidates, 0
  //     dropped, `unsigned/flip-branch/flip-join/merge-names/addr-home/expr-home/coalesce-v9-v23/
  //     initfirst/raw-globals`) takes it from 473 to 459 against `build/src/gfx.o` — 14 points of
  //     today's residual. The same edit against the OTHER decomp's object reads 479 to 462; that
  //     rig scores the identical winner C 6 points higher, so the two are not interchangeable.
  //   • ADDING five preheader reads of the same shape to the reference C: 207 to 386, i.e. +179,
  //     with the three coercions deleted. With them in play the same edit reads 12 to 366 (+354),
  //     which is the number this comment first recorded. +179 is the honest one — the coercions
  //     and the materialisation contend for the same registers, so stacking them double-counts.
  // Both endpoints were taken against the ranked winner OF THAT RUN, and its label is not a handle
  // that survives: an axis suffix names a sense relative to the target's DEFAULT, so `/flip-join`
  // in it denotes the opposite spelling to the one it denotes now. The same command today reports
  // `40320 candidate(s) scored, 0 dropped, best unsigned/flip-branch/defsite/merge-names/
  // addr-home/uns-cmp/livebase-block/volatile/coalesce-v17-v10/initfirst/raw-globals: 395`. What
  // transfers between runs is the SHAPE of the edit, never the label.
  // The construct is cheap to carry when everything else is already wrong and a hard blocker once
  // it is not, which is why both directions are quoted rather than either alone.
  //
  // AND THE PRICE IS NOT FOR THE UNDEFINEDNESS — controls on the same reference and rig, each
  // keeping all five preheader materialisations and changing ONLY where their values come from:
  //     five preheader reads of UNDEFINED locals (what this family names) .... 386  (+179)
  //     the three local sources defined at their declarations ................ 402  (+195)
  //     the three defined by assignment just above the copies ................ 392  (+185)
  //     all five sourced from ordinary extra parameters ...................... 399  (+192)
  //     all five sourced from the constant 0 ................................. 246   (+39)
  // Every DEFINED source costs MORE. So the cost is the pin, exactly as the paragraph above says,
  // and not the `undef`: five extra values materialised in a preheader and live across the nest,
  // which is the same register budget `/expr-home` and `/addr-home` spend. Only the constant is
  // cheap, because it is rematerialised and extends no live range. A lever that stops SPELLING the entry
  // as an undefined read but still emits the copy will move these rows by nothing.
  //
  // `loopfall` is the isolate and `loopset` its control: byte-identical C except for the
  // `else { w = 0; }`. Both MATCH now; the pair is what keeps them matching for the same reason,
  // since a rule that dropped a copy the destination still needed would break the control alone.
  //
  // `armfall` and `armdef` are the same pair at the real function's shape: a switch with no
  // default inside a loop, whose arms decide two locals that the body then uses, so BOTH become
  // loop-carried phis with undefined entries. They are coverage, not isolates — and they carry a
  // second thing the pair above does not: agbcc spells `case 0:` of an unsigned switch as
  // `cmp #1`/`bcc`, the SUBTREE BOUND rather than the value, so recovering it needs a relational
  // dispatch edge admitting exactly one value to route a case (structure/switch-recover.ts). Read
  // as navigation instead, that arm is a second default candidate, the whole tree declines to
  // if-nesting, and both the compare and the arm layout change with it. `armdef` MATCHes on that,
  // and is also what pins the reading's three refusals: the BRANCH of the test, never its
  // fall-through; never the test that OPENS the dispatch; and only on a compiler that declared the
  // spelling (`switchAllowsBoundCase` — agbcc alone). Each is a shape `emit_case_nodes` cannot
  // emit, so a relational test in it is an ordinary comparison and recovers as one.
  // What the pair adds over `loopfall` is that the undef survives multi-arm merging: `armdef`
  // carries no preheader read and `armfall` carries one, `v3 = a2;` — the argument-register
  // fabrication the rules above cannot reach. It costs `armfall` nothing at this rung, for the
  // reason `loopfall` records: `a2` arrives in the register `v3` is allocated to, the copy
  // coalesces, and agbcc emits no instruction for it. `armfall`'s residual 8 is the ZERO-TRIP
  // GUARD instead — the ROM inits the counter above the test (`mov r6,#0 / cmp r6,r7 / bcs`)
  // where the candidate tests the bound against zero and then stages the second induction
  // register in two moves. The `/initfirst` sibling is enumerated and scores 9, so the
  // guard-placement family does not close this shape on its own.
  //
  // WHY THERE IS NO ROW FOR MORE UNDEFINED ENTRIES. A ladder was measured off this family's own
  // shape, holding it fixed and varying only how many locals the arm decides (agbcc; each control
  // the same C plus the `else`, and every control MATCHes). Re-measured with the two rules above in
  // place, because the first ladder was taken without them and its symptoms no longer reproduce:
  // rung 1 is `loopfall` itself at 0, rung 4 is 14, rung 5 is 28, rung 6 is 31.
  //
  // The rungs do not stay in one class, and the claim is only about the one they leave. Every entry
  // agbcc homes in r4-r7 costs nothing now. What the higher rungs add is entries homed in an
  // ARGUMENT register — at rung 4 agbcc takes r7/r5/r4/r3 and asmlift fabricates `a1` for the r3
  // one, and no `nonArgRegs` rule can cover that, because a caller really can pass a value in r3.
  // So: no longer rung is a REGISTER fabrication this pair does not already hold, and the residue
  // above rung 3 is the argument-register fabrication `armfall` gates at 23. (The first ladder
  // reported the rung-4/5 read as `ldr r3, [sp, #N]`, an incoming STACK argument. That was the
  // pre-rules shape: rung 6 spills a real entry to `[sp]` and asmlift still fabricates a register
  // for it, so nothing here reaches a fabricated stack argument.)
  //
  // Multiplicity was severity in the first ladder and stays so: NO choice of fabricated parameter
  // was free at ANY rung (at rung 1 the three spellings scored 13/12/9, at rung 3 all six
  // permutations 8..11), and only a spelling that materialised NOTHING reached 0 — which is what
  // the two rules above now emit for the callee-saved homes.
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

  // A BASE THE ARMS SHARE, AND A CONSTANT INDEX THAT NEEDS NONE: one fold, two surfaces, and
  // asmlift loses a different thing to each. The struct and the base are LoadBGTilemapData's —
  // a 28-byte `gBgInfo` element at 0x03003430.
  //
  // THE COMPILER FACT, from the pair compiled with the benchmark's agbcc. When an address
  // constant sits in the SAME syntactic PLUS tree as a member's byte offset, agbcc reassociates
  // the offset ONTO the base — `split_tree` (fold-const.c:1216) accepts the address as the
  // constant term at :1253, and `associate:` (:4959) rewrites it into `VAR +- (ARG1 +- CON)`
  // (:5009) — and thumb.h's `LEGITIMIZE_ADDRESS` (thumb.h:926) is EMPTY, so it never comes back.
  // The offset therefore leaves the load's free `[rN, #imm]` displacement:
  //   int a = m[i].hLength; int b = m[i].vLength;        ->  9 insns  .word 0x3003430  [r1,#0x10]/[r1,#0x12]
  //   ((u16 *)(i*28 + 0x03003430))[8]; … [9];            -> 11 insns  .word 0x3003440  ldrh [r0]/[r1]
  //   u16 *p = (u16 *)(i*28 + 0x03003430); p[8]; p[9];   ->  9 insns  .word 0x3003430  — back to the ref
  // Parking the base in ANY local breaks the plus tree and restores the displacement, so the
  // re-cast and the index constants are innocent; only the tree is the discriminator. The pair
  // behaves identically over a named `extern` (9 / 11 / 9 insns, `.word gBgInfo` /
  // `gBgInfo+0x10` / `gBgInfo`) and over the raw address above — which is what lets these rows
  // use an address macro and still measure the real thing.
  //
  // SURFACE 1, THE ADD — `bgshare` and `bgswitch`. Where something else wants the base plain,
  // agbcc keeps `.word 0x3003430` and pays the reassociation as an `add` on the loaded value.
  // Grep these two for a baked pool word and there is none on EITHER side: 2 and 3 plain words in
  // the target, the same 2 and 3 in the winner. On the target side nothing folds at all, because
  // the reference spells every access as a struct member and the member offset is therefore never
  // in the address constant's plus tree — which holds for the two MATCH rows equally, and for a
  // one-member-per-arm shape that shares nothing (`.word 0x3003430` twice, `[r0,#0x10]` and
  // `[r0,#0xc]`). On the winner side the base stays plain because the local asmlift minted wants
  // it plain. `bgshare`, target against winner:
  //   target   …  add r0,r0,r1                                     / ldrh r1,[r0,#0x10]
  //   winner   …  add r2,r0,r1 / add r1,r1,#0x10 / … / add r0,r0,r1 / ldrh r1,[r0]
  //
  // SURFACE 2, THE BAKE — `bgfixed`. Where nothing wants the base plain, the folded address
  // becomes its own pool word. The reference reads `gBgInfo[2].tileRow`, so agbcc folds the
  // constant ARRAY index and stops there (`.word 0x3003468` + `ldrh [r0,#0xe]`); asmlift emits
  // `((u16 *)50345064)[7]` and folds the member offset in too (`.word 0x300346c` + `ldrh [r0]`).
  // The branch is not what makes it fire — the same two accesses straight-line, with no `if` at
  // all, score 2 by the same divergence. `bg_area`/`bg_mix` cannot cover this surface even though
  // `bg_mix` reads a fixed element of the same shape: their base is 0x02000000, which agbcc
  // materializes as `mov #0x80` + `lsl #0x12` and reaches at `add #0x38`, so there is no pool
  // word for an addend to hide in. A pool-loaded base is a precondition of surface 2.
  //
  // WHAT ASMLIFT DOES WITH SURFACE 1, measured. Where the target emits a member's load ONCE in a
  // block that more than one arm reaches, the base is live OUT of each arm; asmlift correctly
  // homes it — `v0 = (u16 *)(a0 * 28 + 50345008);` — and then spells the arm-local access beside
  // it as `((u16 *)(a0 * 28 + 50345008))[8]` instead of `v0[8]`. Taking asmlift's own printed
  // winner and changing ONLY those inline re-spellings to read the local it had already minted
  // compiles BYTE-IDENTICAL to the target (`cmp -l` reports 0 differing bytes) on both gap rows,
  // where the unmodified winners differ in 237 and 250 bytes. The whole residual is that one
  // choice, and no axis in the fan reaches it: `bgshare`'s entire fan is 4 candidates scoring
  // 8, 8, 9, 9 (`unsigned`, `signed`, `unsigned/flip-join`, `signed/flip-join`) and `bgswitch`'s
  // is 2, both 8. `bgfixed`'s endpoint is byte-exact too, and it is the OPPOSITE edit: re-spell
  // its one folded site as the fixed element's member and 4 becomes 0 differing bytes, while the
  // fan's own attempt to home that base — `/livebase`, present at 11 and 13 against the winner's
  // 4 — is the mint, and loses.
  //
  // SURFACE 1'S DISCRIMINATOR IS A PROPERTY OF THE TARGET, not of the source. A member named in
  // two arms is NECESSARY and NOT SUFFICIENT; what decides it is whether agbcc puts that load in
  // a join block, and both the dispatch construct and the ORDER of the two reads decide THAT:
  //   two-arm if/else, shared member read LAST   -> 8      `bgshare`   target: `ldrh [r0,#0x12]` once, at `.L5`
  //   two-arm if/else, shared member read FIRST  -> MATCH  no row      target: its own copy in EACH arm
  //   two-arm if/else, members disjoint          -> MATCH  `bgsplit`
  //   three-arm switch, one member shared        -> 8      `bgswitch`  target: once at `.L8`, case 1 falls in
  //   three-arm switch, members disjoint         -> MATCH  `bgswsplit`
  //   three-arm if/else-IF chain, shared         -> 12     no row      target: its own copy in EACH arm
  // Reading the shared member FIRST shares it in the source exactly as `bgshare` does and the
  // class does not fire, so do not prune or widen the family on "one member shared" alone.
  // `bgswitch`'s own `default` arm makes the same point from inside a row — it reads `hLength`,
  // which `case 0` also reads, and the target emits that `ldrh [r0,#0x10]` TWICE, once per block;
  // only `vLength`, shared by the two ADJACENT arms, gets a join block.
  //
  // WHAT THE ROWS GUARD. `bgsplit`/`bgswsplit` mint no base local at all, so they pin the
  // struct-array recovery that already works and cannot over-fire a lever that prefers a minted
  // local — there is none there to prefer. `bgbaked` is the family's real over-fire guard, and it
  // guards the other surface: its target genuinely wants the folded word, asmlift spells it
  // straight (`*(s32 *)50345068`) and MATCHes, and re-spelling that one site as the fixed
  // element's member — the edit that takes `bgfixed` to byte-exact — costs it 2. The two gap rows
  // therefore pull in OPPOSITE directions at the same kind of site, and neither endpoint is safe
  // as an unconditional default.
  // `bgswsplit` is also not a one-member contrast, and cannot be: changing ONLY `case 1`'s second
  // member of `bgswitch` (`vLength` -> `tileRow`) still scores 8, because the sharing moves to
  // cases 1/`default`. Two arms have to change to remove it, so `bgswsplit`'s MATCH is consistent
  // both with "the sharing is gone" and with "this member set happens to match"; `bgsplit`, where
  // one member changes and nothing else does, carries the clean contrast.
  //
  // THE STRUCT IS THE REAL FUNCTION'S, NOT A PRECONDITION of surface 1. With `pad19[7]` (sizeof
  // 32, a single `lsl #5` scale and no lsl/sub/lsl chain) `bgshare` still scores 8 with the
  // identical mint-then-respell winner, and with the arm-local members moved to offsets 0 and 2 —
  // nothing for a displacement to hold — it scores 10 with the same winner shape. The 28-byte
  // stride and the 0xc–0x16 member offsets are here because they are `gBgInfo`'s.
  //
  // ATTRIBUTION, so nothing here is credited to the wrong gap:
  //  • `bg_area`/`bg_mix` above already pin the STRAIGHT-LINE variable-index capability over this
  //    same 28-byte stride: `bg_area` MATCHes on all four toolchains, `bg_mix` on agbcc/kmc/mwcc
  //    and is 1 on ido7.1. They are coverage for that, and for neither surface here.
  //  • `armfall` (agbcc, nonmatch 8, `unsigned/merge-names`) is a switch over struct-array members
  //    at this very base and is NOT coverage: its winner spells the base as a pointer induction
  //    variable (`v0 = v0 + 2;`) and reads `*v0`/`v0[1]` — the safe local form, with no inline
  //    re-spelling anywhere. Its 8 is its own `uninit-local`/`merge-chain` axis. `armdef` MATCHes.
  //  • No `uninit-local`: every local is assigned on every path. `merge-chain` goes on the four
  //    whose arms decide `a` AND `b`, both computed loads — the tag describes the body, not
  //    the residual, so the two MATCH rows carry it as well.
  //  • EXCLUDED, with the machinery it belongs to: a clamp over the same base (`a = m[i].hLength;
  //    if (sel) a = 32; b = m[i].vLength;`) scores 22, but its winner uses the struct-member form
  //    throughout and mints no base local — clamp/merge-init, not this.
  //
  // agbcc only, like the `reread` and `arm*` families above — but as a family CONVENTION, not as a
  // tested exclusivity claim. The pair was compiled on agbcc alone, and of the three mechanisms
  // cited only thumb.h's empty `LEGITIMIZE_ADDRESS` is ARM-Thumb's: `split_tree`/`associate:` live
  // in `fold-const.c`, the target-independent folder agbcc inherits from GCC 2.x, and join-block
  // tail sharing is a target-independent RTL pass. Whether these rows reproduce on the other three
  // toolchains is UNTESTED — no cross-compiler run was attempted.
  // WHAT THESE ROWS DO NOT MEASURE, stated because it is the other half of the question they came
  // from: the NAMED-symbol spelling. These use an address macro, codegen-equivalent for the fold
  // (verified above). This paragraph once said a row relocating against a named `gBgInfo` "fails
  // candidate compilation" and left the naming question "to the real tier and to no row here";
  // BOTH halves are FALSE and are corrected here rather than left standing. asmlift synthesizes
  // the declaration off the target asm, so such a candidate compiles and scores — and the GLOBAL
  // ARRAY SHAPE family far below is exactly a `bgarr` row relocating against a named `gBgInfo`.
  //
  // THE LBG NOTE, with this family's own share of that row priced rather than assumed away. On
  // `kleod:LoadBGTilemapData:agbcc` the 386 winner's pool holds 20 `.word` against the ROM's 20
  // `.4byte`, and it bakes four `gBgInfo` addends (+0x4, +0x3c, +0x48, +0x4a) where the ROM bakes
  // three (+0x4, +0x48, +0x4a), carrying 8 plain `0x3003430` words against the ROM's 9. The extra
  // `+0x3c` is the pool word the two `((s32 *)50345008)[15]` sites share — surface 2, `bgfixed`'s.
  // Taking that winner and parking the base of those two sites in a local scores 383 against its
  // own 386 and leaves the ROM's 9 plain words with no `+0x3c`; one site alone is 385 either way.
  // So this family reaches that row and is worth at least 3 of its 386 — but 3 is the whole
  // respelling including register-allocation churn (104 diff lines, mostly r4/r5 renaming), not a
  // per-instruction decomposition, and neither row's endpoint produces it. `bgshare`/`bgswitch`
  // gate preferring an ALREADY-MINTED local, and a local DOES hold that base in that fan — 16,128
  // of the 68,352 candidates read the cell through one, best 399, MEASURED AT #138 (`84aa4222`)
  // AND NOT RE-RUN SINCE — so the missing capability is
  // not a MINT but the SELECTION of which keys get one, which is the
  // `livepark`/`foldpark`/`unfoldpark` family below. `bgfixed` gates the fixed-element member
  // spelling, and applying THAT to the same two sites scores 386, unmoved, because the ROM reaches
  // the member from the plain base at `#0x3c` rather than from the element base. Surface 1 occurs
  // nowhere in that winner at all.
  {
    sym: 'bgshare',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgshare(int i, int sel) { int a, b;\n' +
      '  if (sel) { a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; }\n' +
      '  else     { a = gBgInfo[i].tileCol; b = gBgInfo[i].vLength; }\n' +
      '  return a + b; }',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgshare(int i, int sel);',
  },
  {
    sym: 'bgsplit',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgsplit(int i, int sel) { int a, b;\n' +
      '  if (sel) { a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; }\n' +
      '  else     { a = gBgInfo[i].tileCol; b = gBgInfo[i].tileRow; }\n' +
      '  return a + b; }',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgsplit(int i, int sel);',
  },
  {
    sym: 'bgswitch',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgswitch(int i, int sel) {\n' +
      '    int a, b;\n' +
      '    switch (sel) {\n' +
      '    case 0:  a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; break;\n' +
      '    case 1:  a = gBgInfo[i].tileCol; b = gBgInfo[i].vLength; break;\n' +
      '    default: a = gBgInfo[i].hLength; b = gBgInfo[i].tileRow; break;\n' +
      '    }\n' +
      '    return a + b;\n' +
      '}',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgswitch(int i, int sel);',
  },
  {
    sym: 'bgswsplit',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgswsplit(int i, int sel) {\n' +
      '    int a, b;\n' +
      '    switch (sel) {\n' +
      '    case 0:  a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; break;\n' +
      '    case 1:  a = gBgInfo[i].tileCol; b = gBgInfo[i].tileRow; break;\n' +
      '    default: a = gBgInfo[i].unk14;   b = gBgInfo[i].unk16;   break;\n' +
      '    }\n' +
      '    return a + b;\n' +
      '}',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgswsplit(int i, int sel);',
  },
  {
    sym: 'bgfixed',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgfixed(int i, int sel) { int a, b;\n' +
      '  a = gBgInfo[i].hLength;\n' +
      '  b = gBgInfo[i].vLength;\n' +
      '  if (sel) return a + gBgInfo[2].tileRow;\n' +
      '  return b + gBgInfo[2].tileRow; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'int bgfixed(int i, int sel);',
  },
  {
    sym: 'bgbaked',
    src:
      '#define gBgTilemapPtr (*(s32 *)0x0300346c)\n' +
      'int bgbaked(int m, int n) { return m * gBgTilemapPtr + n * gBgTilemapPtr; }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'int bgbaked(int m, int n);',
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
  // `/livebase` lever re-runs the pass with both ablated, leaving only `single-use`. That lever was
  // ALL-OR-NOTHING over bases — `hoistBaseLocals` hoisted every key the gate list admits,
  // with no candidate for a proper subset. A second admission, LIVEBASE_BLOCK_GATES, adds the
  // `single-cell` gate — a base every access of which is ONE fixed offset stays inline — and rank
  // carries both in one roster (LIVEBASE_ADMISSIONS), fanning every `/livebase` product over each,
  // so this row MATCHES on `signed/livebase-block/volatile` and guards the gate.
  //
  // ATTRIBUTED BY ABLATION, not by reading. Adding one more gate to LIVEBASE_GATES that rejects a
  // numeric base outside MMIO — per-base selectivity in its crudest form — takes this row from 11
  // to MATCH. Re-running the WHOLE synthetic tier under it (604 rows) moves exactly one other row,
  // and that row is the finding's other half: `sizebound` goes 16 → 20, because it reads
  // `*(u16 *)0x03001048` in two loop bounds and hoisting THAT base is correct. So the pass is
  // right about the spelling and wrong about which bases get it — and an address threshold is NOT
  // the predicate to fix it with: it pays 4 points on `sizebound` for the 11 it wins here.
  // `sizebound` is the row that referees whatever predicate a future lever proposes, and the
  // shipped `single-cell` gate FAILS it as a rule, exactly as the address threshold does: that
  // base is reached at one fixed offset only, so `-block` leaves it inline and its best spelling
  // scores 36 where the winner that binds it scores 16. The row holds at 16 because the gate never
  // SUBTRACTS a candidate — `/livebase` rides beside it and wins — and that coexistence is the
  // whole reason a per-base predicate is allowed to be wrong. One that PRUNES has to be right.
  //
  // WATCH THE SIGN when writing one. `dma_wait:mwcc_242_81`'s base is 0xcc006000, which the IR
  // carries as a NEGATIVE 32-bit constant; a first cut of the probe compared the key as a signed
  // decimal, rejected that base, and LOST a MATCH the tier already had. Reading it unsigned
  // restores it. A per-base predicate is a place where a sign error costs a row silently.
  //
  // THE `/volatile` SUBSET CAP IS NOT A SECOND BLOCKER — measured, because it looks like one.
  // `volatileSubsetCandidates` (l3/volatileptr.ts) returns `[]` outside `2 <= eligible <= 3`, and
  // this row has four eligible locals, so no `/volatile-<name>` label exists here. Raising the cap
  // to 8 makes eleven subset labels appear and leaves the row at 11 — every one of them still
  // binds all four bases, and even the subsets that qualify exactly the DMA base score 11. Subset
  // VOLATILITY on an all-or-nothing HOIST buys nothing. Do not spend a round on the cap.
  //
  // `mixpoll` is the isolate: one DMA register file that must be a bound `volatile` local, and
  // three IWRAM scalars that must stay inline absolute derefs. The ROM's own C is the reference,
  // and hoisting the three IWRAM cells is what costs — measured by hand-editing asmlift's own
  // winner one clause at a time against the same object:
  //     all four bound, all four volatile (plain `/livebase/volatile`) ........... 11
  //     all four bound, only the DMA base volatile .............................. 11
  //     all four bound, none volatile .......................................... 27
  //     ONLY the DMA base bound, volatile, the three IWRAM cells inline .......... 0  ← MATCH
  //     only the DMA base bound, NOT volatile ................................... 21
  // So the 11 is the hoist alone (qualifying the IWRAM cells `volatile` on top of the wrong hoist
  // is worth 0 here), and `volatile` on the base that needs it is worth 21 — the lever pair is
  // right about both bases and wrong about which ones. A base census over the enumeration without
  // the gate: all 12 candidates bound either 0 or all 4 numeric bases, and marked 0 or 4 of them
  // `volatile`. The gate adds 8 (12 → 20), and all eight bind the DMA base alone — one block hoist
  // crossed over {unsigned, signed} × {plain, /expr-home} × {plain, /volatile}; the scored
  // `/livebase-block` reads 21, the number hand-editing that clause produced.
  //
  // The MIRROR admission — bind the scalar cells, leave the register file inline — is deliberately
  // NOT on rank.ts's roster, and what it would cost is measured rather than guessed: one gate table
  // with the complementary predicate plus one row there (a gate can only reject MORE, so it is
  // never an extra entry in LIVEBASE_BLOCK_GATES), and with it in the list the corpus enumerates
  // 8141 candidates against 7405 while not one of the 856 rows changes outcome, score or winning
  // label. It goes on the roster when a row asks for it.
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
  // Cut from kleod:LoadBGTilemapData:agbcc, and it pays there. The row exists because a base census
  // over that function's enumeration returned four shapes and no others: bind nothing, bind
  // 0x03003430 alone (`/nearbase`'s cluster), bind all five of 0x03003430 / 0x03003478 /
  // 0x0300347A / 0x030034A0 (IWRAM) and 0x040000D4 (the DMA register file) plain, and bind those
  // same five all `volatile`.
  // Not one bound the DMA base alone. With the gate, the narrower hoist IS LBG's ranked winner —
  // `docs/ranked-repro.md`'s command, run either side of it (an A/B against itself: the candidate
  // counts below are that pair's, not a fan size to reproduce):
  //
  //   without  17152 candidate(s) scored, 0 dropped, best …/addr-home/livebase/volatile/
  //            coalesce-v20-v17/initfirst/raw-globals: 419
  //   with     26880 candidate(s) scored, 0 dropped, best …/addr-home/livebase-block/volatile/
  //            initfirst/raw-globals: 406
  //
  // 419 → 406, attributed twice over: the with-gate log's best candidate carrying no `-block` label
  // reads 419 exactly, which is what the without-gate log's winner scores. The 9728 extra
  // candidates are what fanning every `/livebase` product over both admissions costs on a function
  // that inhabits them, and 5120 of them are the `/coalesce` pairing — worth 21 points on
  // `/livebase` here (440 → 419) and nothing on the narrow admission, whose best paired spelling
  // reads 408, two behind going unpaired.
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
  // arm's FIRST statement must be the init `v = X`, and the guard's other side must be X ITSELF.
  // `unsguard` is the row where a sibling lever contends for that side. Its counter is unsigned,
  // so the match needs `/uns-cmp` (structure.ts unsignedCompareSpelling) to spell the loop compares
  // unsigned, and that axis renders the guard's constant side as `(u32)0` — not the init's `0` to
  // a structural match. So this row is what pins the side match's CAST TOLERANCE (l3/initfirst.ts):
  // the match lives in the ONE candidate carrying both spellings, and each alone falls short —
  //     unsigned/uns-cmp/livebase/volatile/initfirst ................  0  ← MATCH
  //     unsigned/livebase/volatile/initfirst ........................  2
  //     unsigned/uns-cmp/livebase/volatile ..........................  5
  // What stands between them is the cast alone, not a hoist — `/uns-cmp` moves no statement — and
  // the tolerance stops at WIDTH 32, since a narrowing cast is not the value `v = X` stores. This
  // is the only row in the 604-row synthetic tier that tolerance moves, `sizebound` included,
  // which carries both axes.
  //
  // `signguard` is the control, and it differs by ONE token: `s32 i` for `u32 i`. Nothing else in
  // the C changes, the halving keeps its `(u32)` cast so it stays an `lsr` on both, and asmlift
  // MATCHes it with `/initfirst` in the label. So the pair brackets the gap exactly: the guard
  // re-spelling works, and it is the unsignedness that removes it.
  //
  // A SECOND blocker sits at the same precondition and has NO row: `/expr-home` can land its hoist
  // at the head of the guarded arm (`if (0 < n) { v0 = 128 << 24; v1 = 0; do …`), and then `then[0]`
  // is not the init. It reproduces on THIS row — of its 30 candidates, 12 carry `/expr-home` and
  // not one of those carries `/initfirst` — but they all score 21 against the winner's 2, and
  // hand-composing the two spellings on that branch recovers a single point (31 → 30 on a hand
  // probe of the `/expr-home` shape). So no row demands it and none was written. What would earn
  // one: a target whose ranked winner carries `/expr-home` with the hoist INSIDE the guard.
  // THAT CRITERION IS NOW MET, and the answer did not change. kleod:LoadBGTilemapData:agbcc's
  // ranked winner (386) carries `/expr-home` AND `/initfirst`, with the hoist landing exactly
  // here — `if (0 < *(u16 *)50345082) { v5 = 128 << 24; v14 = 0; do …`, so `then[0]` is the
  // hoist and the pass never looks at the init on the next line. Priced on that winner's own C,
  // one line moved and nothing else, each variant compiled and scored against the ROM object:
  // 386 with the init hoisted above the guard and the guard still testing the constant, and 384
  // when the guard's constant side is ALSO re-spelled against the hoisted init. The class is
  // worth 2 there, against the 35 the same edit is worth in the REFERENCE's spelling basin, so
  // it still earns no row — but now because it was measured, not for want of a target.
  // (`sizebound:agbcc` carries both `/expr-home` and `/initfirst`, because there the homed value
  // is parameter-derived and agbcc materialises it before the guard — that composition is not the
  // broken one.)
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

  // ── NARROW LOOP COUNTERS, AND THE ADDRESS SPELLING THEY UNLOCK ────────────────────────
  // A counter declared `s16 i` is not a cosmetic choice: on agbcc it CHANGES WHICH LOOP THE
  // COMPILER EMITS. Compiled pairs, this agbcc, `-mthumb-interwork -O2 -fhex-asm
  // -fprologue-bugfix`:
  //     s32 i, `s += i`      : mov r1,#0x0 / add r0,r0,r1 / add r1,r1,#0x1        (no extension)
  //     s16 i, `s += i`      : lsl r0,r1,#0x10 / asr r0,r0,#0x10 / add r2,r2,r0 /
  //                            add r0,r0,#0x1 / lsl / lsr r1 / asr r0             (`widecnt`,
  //                                                                                `narrowcnt`)
  // The sign extension is materialised ONCE and reused for both the use and the increment, and
  // the raw halfword is kept live beside it.
  //
  // WHY THE INDEX SURVIVES. Not register pressure: with a WIDE counter and five extra live
  // accumulators (enough that agbcc allocates r8 and pushes it) agbcc still eliminates the
  // induction variable and emits the pointer walk `add r1,r1,#0x2 / add r3,r3,#0x2`. It is the
  // RTL SHAPE of the counter's write-back, in two steps that are in the compiler:
  //   1. `gcc/thumb.h:344` PROMOTE_MODE forces `UNSIGNEDP = 1` for EVERY sub-word integer mode,
  //      so a declared `s16` local is kept ZERO-extended in its SImode home and the sign-extended
  //      value is re-derived beside it — the `lsr r3,r1,#0x10` next to `asr r1,r1,#0x10` in
  //      `membnarrow`'s target. The write-back is therefore `(lshiftrt (ashift (plus …) 16) 16)`.
  //   2. `gcc/loop.c` `basic_induction_var` has a case for SIGN_EXTEND (5876) and one for
  //      ASHIFTRT (5880); its own comment at 5756-5762 excludes ZERO_EXTEND on purpose
  //      ("overflows … are defined … So we only check for SIGN_EXTEND and not ZERO_EXTEND").
  //      LSHIFTRT has no case and falls to `default: return 0` (5902). No BIV ⇒ no strength
  //      reduction ⇒ the indexed address survives, and only THEN does the base spelling decide
  //      what agbcc hoists.
  // Instrumented rather than read, by compiling the two RTL shapes with the SAME `s32` local over
  // the same range, so declared width, liveness and pressure are all held fixed:
  //     i = ((i + 1) << 16) >> 16   (ASHIFTRT) → add r1,r1,#0x2 / add r2,r2,#0x2 — IV ELIMINATED
  //     i = (s32)(u16)(i + 1)       (LSHIFTRT) → lsl r0,r2,#0x1 / add r1,r4,r0   — index SURVIVES
  // `u16 i` blocks the elimination the same way — PROMOTE_MODE unsigns both, so both reach the same
  // LSHIFTRT — but only `s16` also pays for the materialised sign extension: swap `membnarrow`'s
  // counter to `u16` and the object is 17 rows from its own `s16` target.
  //
  // So the two gaps compose in one direction only: with a wide counter asmlift MATCHES the
  // member-array walk (`membwalk`, agbcc), and it is the narrow counter that exposes the address
  // spelling. Both levers ship. L1 is `raise/narrowlocal.ts`: a block parameter whose sole reader
  // is its own extension is declared at that width, so the counter is `s16 v0` read without a cast.
  // L2 is `raise/memberarrays.ts`: a constant offset feeding a variable-index walk selects a
  // struct's array MEMBER, so the walked region is `a0->field_4[v0]` and agbcc gets the
  // loop-invariant base to hoist that `(a0 + 2)[v0]` never gave it.
  //
  // WHICH LEVER IS WORTH WHAT. Every number is measured on THAT ROW'S OWN target, starting from
  // asmlift's OWN published winner for the row and changing ONE axis — never by subtracting two
  // rows' scores, which are two different functions with two different targets:
  //     L1 = give the local a narrow type (`s16 v0`, casts dropped) instead of `s32 v0` + `(s16)v0`
  //     L2 = render the walked region as an array MEMBER of a synthesized struct
  //                   asmlift  L1 alone  L2 alone  L1+L2
  //     widecnt        MATCH      —         —        —    CONTROL: wide counter, no memory
  //     membwalk       MATCH      —         —        —    CONTROL: the member walk under a WIDE
  //                                                       counter — the address spelling costs
  //                                                       nothing on its own, so a fix for it must
  //                                                       not be credited with a narrow-counter row
  //     narrowcnt          1   0 MATCH      —        —    L1 alone, no memory
  //     basefold          11   0 MATCH      —        —    L1 alone, WITH memory traffic
  //     membnarrow        17     11        16     0 MATCH L1 + L2: the hoisted preheader base and
  //                                                       the base-first index add
  //     sibwalk           52     25        33     0 MATCH L1 + L2 over three sibling walks under one
  //                                                       `s16` counter; also the guard below
  // The `asmlift` column is the state before either lever; `L1+L2` is what `pnpm bench run` reads.
  // WHAT THE ROWS PRICE IS A CONJUNCTION. Alone, L1 closes `narrowcnt` and `basefold` outright but
  // takes only 6 of `membnarrow`'s 17 and 27 of `sibwalk`'s 52; L2 alone is worth 1 and 19, and 0
  // under a wide counter. The decomposition held to the point: L1 shipped first and left the two
  // member rows at exactly 11 and 25, and L2 on top of it closed both to a byte match.
  // `narrowcnt`'s single row is the capability in miniature: the target derives the increment from
  // the ALREADY-EXTENDED value (`add r0,r0,#0x1`), asmlift's cast spelling re-derives it from the
  // raw halfword (`add r0,r1,#0x1`).
  //
  // `basefold` SIZES L1; it is not an association probe. BOTH sides fold the `+4` into the memory
  // operand — target `ldrh r0,[r0,#0x4] / strh r0,[r2,#0x4]`, asmlift `ldrh r0,[r0,#0x4] /
  // strh r0,[r1,#0x4]` — and changing ONLY the local's declared type in asmlift's winner makes the
  // object BYTE-IDENTICAL to the reference (`cmp` passes), so its 11 is 100% L1. What it buys over
  // `narrowcnt` is SCALE: the extension feeds the address too, so the target spends `lsl #0x10 /
  // asr #0x10` then `lsl #0x1` where asmlift fuses both into `asr #0xf` — one missing capability
  // costing 1 row in a scalar loop and 11 in an addressing one. Its `src` is AUTHORED, not cut from
  // the project: sa3:PackSaveSector's reference has 22 `p->member[i]` and no pointer cast in 117 lines.
  //
  // THE LEVER THIS FAMILY DOES **NOT** GATE, measured rather than assumed. asmlift mints a fresh
  // local per loop (`v0`, `v1`, `v2`) where the source reuses one `i`, and on sa3:PackSaveSector
  // breaking that ONE spelling on an otherwise byte-matching source costs 243 rows — so "reuse the
  // counter" is the first lever a reader will reach for. It buys NOTHING at synthetic scale. Taking
  // asmlift's own winner and collapsing every minted counter onto one, scored against the same
  // object; the probes are N sibling `u16` arrays whose lengths cycle 6/7/9, walked in order:
  //     3 sibling loops   minted 52  reused 52          9 sibling loops   minted 191 reused 191
  //     5 sibling loops   minted 102 reused 102        11 sibling loops   minted 235 reused 235
  //     7 sibling loops   minted 148 reused 148        14 sibling loops   minted 301 reused 301
  // Identical at every scale, to the row — and identical again in the state a round will actually be
  // in, AFTER L1: `sibwalk` L1-minted 25, L1-reused 25. The 243 is a PRESSURE interaction (that
  // function has 18 hoisted invariants competing for registers), not a spelling agbcc reads.
  // `sibwalk` is the guard: if a round ships counter reuse, this row must not move.
  //
  // DECLINES, each named by asmlift's own message and each a PRE-EXISTING link, never this family:
  //     widecnt   × gcc2.7.2kmc : "cannot lift 'widecnt': unmodelled control transfer 'bnezl' at
  //                               0x14 — branch-likely / coprocessor branch not supported"
  //     narrowcnt × ido7.1      : the same `bnezl` link, at 0x1c
  //     narrowcnt × gcc2.7.2kmc : the same `bnezl` link, at 0x28
  // The MIPS toolchains emit the counted loop with a branch-likely delay slot, so those three cells
  // measure that link. Every other cell scores.
  //
  // WHY THE ctx SAYS `u8 *`. `ctx` reaches m2c ONLY — `evaluateM2c` is the only tool call that takes
  // it, `runAsmlift` has no such parameter — so the spelling moves m2c's column and can never move
  // asmlift's, which is why it has to be chosen honestly. `void *` is not honest here: m2c's BODY is
  // byte-identical under `void *` and `u8 *`, but on `void *` it dereferences the void pointer
  // (`*(d + 4 + temp_r0) = …`) and no compiler in the set accepts that, so the noncompile would be
  // the harness's, not m2c's. `u8 *` withholds the layout just as completely, and under it m2c
  // compiles — and where it lands is the L1/L2 split itself: withholding the layout costs m2c
  // exactly what the two levers are worth, and it keeps paying it after they ship.
  //     membnarrow  m2c 11, asmlift MATCH — the 11 m2c is left with is L2's
  //     sibwalk     m2c 26, asmlift MATCH
  //     membwalk    m2c  2 under BOTH spellings — the control that says the swap is not a general
  //                 m2c boost; it moves exactly the narrow-counter rows.
  // Not the real `struct S *`, because THE LAYOUT IS THE ANSWER: given it m2c emits
  // `d->name[temp_r1_2]` and byte-MATCHes `membnarrow` (measured, 0) — that is L2 handed over, and
  // a synthetic row gives asmlift no analogue for it. Every remaining noncompile is m2c's own: on a
  // real, dereferenceable pointer type it still invents a struct member — `(temp_r0 + d)->unk4` on
  // agbcc/basefold, `->unk4`/`->unkC` on gcc2.7.2kmc, "Selector requires struct/union pointer" on
  // ido7.1, "not a struct/union/class" on mwcc; no void*/incomplete-type marker is left here. The
  // harness gap this exposed is PRE-EXISTING: the synthetic tier hands `ctx` to m2c to READ but
  // never to the candidate COMPILE, where the real tier escalates to the project context for
  // exactly this reason (compile/real.ts:52-54 — "a harness artifact, not a decompiler weakness").
  // 23 synthetic rows in older families still carry markers in that class; that is its own change.
  //
  // COVERAGE. No row CARRIED the `narrow-counter` tag before this family — trivially, the tag is new.
  // The SHAPE was not uncovered. Reference side: 22 base rows pass this tag's own floor predicate,
  // 18 agbcc, and one of those (`kleod:UpdateEntities:agbcc`) already MATCHES — a narrow counter is
  // not automatically a gap. Candidate side: 17 base agbcc rows already carry a narrowed self-
  // increment in their PUBLISHED asmlift output, 2 of those MATCHing; exactly ONE carries the SIGNED
  // form these rows are cut from, `v = (u16)((s16)v + 1)` — `sa3:PackSaveSector` (366). That row's
  // 15 unsigned siblings were where movement was predicted to show first; L1's own `bench diff`
  // moved TWO real rows and neither is among them — `sa3:PackSaveSector` 366 → 360 (7 counters, and
  // the winner drops `/vol-slot`) and `sa3:sa2__sub_8007958` 68 → 67 (one `s8`). The prediction was
  // wrong because the published SPELLING is not the gate: what the pass reads is whether the
  // carrier has a second reader. What the six counter rows add is ISOLATION and SIZE: the shape
  // alone, plus memory, plus a struct member, each on its target.
  //
  // TOOLCHAIN SCOPING. All nine ship `toolchains: ALL` as COVERAGE; the analysis above is agbcc's
  // alone. On mwcc_242_81 `membnarrow`, `basefold` and `sibwalk` all MATCH outright, so the gap
  // does not exist on that compiler; `narrowcnt` is 16 there, and the MIPS lanes score something
  // structurally different (ido7.1 4/4/12, gcc2.7.2kmc 7/7/21). Those cells are coverage, not
  // evidence for the thesis.
  //
  // THE THREE `merge*` ROWS ASK A DIFFERENT QUESTION: not what a narrow counter is worth, but
  // WHERE THE EVIDENCE FOR A NARROW LOCAL IS. Off a loop there is no back edge to carry the
  // write-back truncation, so gcc sinks it past the join and it arrives as the carrier's own
  // reader. `raise/narrowlocal.ts`'s `edge-extends` is the rule that decides that, and not one of
  // the carriers it judges over the sa3 corpus is on a real row — these three are what price it:
  //     mergenarrow  `s16 v` across an if/else, read once      MATCH  without the sunk-write-back
  //                                                                   rule it is 6
  //     mergecast    the same merge as `s32 v` + `(s16)v`      MATCH  ADVERSE: a rule that narrows
  //                                                                   on the extension alone spells
  //                                                                   this `s16 v` and scores 6
  //     mergeu16     `u16 v` across the same if/else            MATCH  the DIAMOND half of the
  //                                                                   unsigned column
  //     mergecastu   the same merge as `s32 v` + `(u16)v`       —     the HOISTED half; the row
  //                                                                   the diamond rule must not win
  // The unsigned column was authored as UNDECIDABLE and it is not. `u16 v` and `s32 v` + `(u16)v`
  // do reach `raise/narrowlocal.ts` as the same IR — one `zext16` over raw in-edges — but they do
  // not compile to the same CFG: `gcc/jump.c:443-445` hoists the else arm above the compare for the
  // cast spelling and cannot for the declared one, because `gcc/thumb.h:344` PROMOTE_MODE makes
  // that arm five insns and the transform's guard at `:471-502` wants one. asmlift reads the join
  // shape and takes both cells; m2c takes the narrow spelling unconditionally, so it wins `mergeu16`
  // and pays on `mergecast`. `mergecastu` is the fourth cell and exists to hold the new rule to a
  // score: it is the shape a diamond test must keep REFUSED, and without it the whole column can be
  // won by a gate that simply always narrows.
  //
  // Cut from sa3:PackSaveSector:agbcc (m2c noncompile), and the two levers do not reach it: it is
  // refused for a third reason, a struct carrying constant-offset fields alongside its array members
  // (`direct-access` in raise/memberarrays.ts). That row is CONJUNCTIVE, measured on the winner it
  // published at 366: applying one project spelling at a time recovers 55 rows for the member-array
  // base (366 → 311) and 17 for the narrow counter (366 → 349), while both together reach 267 — a
  // 99-row recovery, more than the 72 the two marginals sum to, and still far from a match; four
  // other single-axis "fixes" make the row WORSE (375, 371, 370, 370). It reaches a byte match only
  // when every spelling is right at once. So these rows size the two capabilities at their own scale
  // and make no claim about how far they move that row alone.
  {
    sym: 'mergenarrow',
    src:
      'void mergenarrow(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s16 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = v;\n' +
      '}',
    features: ['narrow', 'sign-extend', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergenarrow(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergenarrow: { returnsVoid: true } },
  },
  {
    sym: 'mergecast',
    src:
      'void mergecast(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (s16)v;\n' +
      '}',
    features: ['narrow', 'sign-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergecast(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergecast: { returnsVoid: true } },
  },
  {
    sym: 'mergeu16',
    src:
      'void mergeu16(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    u16 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergeu16(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergeu16: { returnsVoid: true } },
  },
  {
    // THE FOURTH CELL of the 2x2 in raise/narrowlocal.ts's header, and the one that stops the
    // unsigned column being won by a gate that simply always narrows. It is
    // `mergecast`'s twin at the other signedness and `mergeu16`'s at the other spelling: same
    // merge, same single `zext16` reader, same raw in-edges, and it must stay REFUSED because
    // agbcc really did hoist the else arm here.
    sym: 'mergecastu',
    src:
      'void mergecastu(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergecastu(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergecastu: { returnsVoid: true } },
  },
  {
    // THE DIAMOND `gcc/jump.c` COULD NOT HAVE HOISTED, and the reason the arm clause in
    // raise/narrowlocal.ts is about the ARM'S OPS and not only the arm's SIZE. Both arms are a
    // single load — one SET each, so an arm-SIZE test admits them — but `gcc/jump.c:483`'s
    // `! may_trap_p (SET_SRC (temp4))` refuses to speculate a MEM above the compare
    // (`gcc/rtlanal.c:1770` MEM -> `rtx_addr_can_trap_p`, `:144` a plain pseudo address CAN trap),
    // so the diamond survives for BOTH spellings and carries no information at all. Narrowing here
    // spells `u16 v` for a source that wrote `s32 v` + `(u16)v` and loses the match.
    sym: 'mergeldcast',
    src:
      'void mergeldcast(s32 *out, s32 *p, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = p[0];\n' +
      '    } else {\n' +
      '        v = p[1];\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergeldcast(s32 *out, s32 *p, s32 c);',
    proto: { mergeldcast: { returnsVoid: true } },
  },
  {
    // THE SAME REFUSAL FROM THE OTHER DIRECTION: an arm that is one C assignment but not one
    // THUMB INSN. `v = a + 0x12345` needs a literal-pool load before the add, so the arm is two
    // insns and `gcc/jump.c:472`/`:474`'s `single_set` on `prev_active_insn` never matches — the diamond
    // survives under the CAST spelling too. In the lifted IR the pool word is a `const` feeding an
    // `add`, which is why the arm clause counts constants: an immediate the target cannot fold is
    // a second SET, and the IR does not say which is which. The FOLDABLE case (`a + 3`, one
    // `adds`) needs no such refusal — agbcc really does hoist it, so the join is not a diamond and
    // the join clause already decides it.
    sym: 'mergepool',
    src:
      'void mergepool(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + 0x12345;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergepool(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergepool: { returnsVoid: true } },
  },
  {
    sym: 'widecnt',
    src:
      's32 widecnt(void)\n' +
      '{\n' +
      '    s32 i;\n' +
      '    s32 s;\n' +
      '\n' +
      '    s = 0;\n' +
      '    for (i = 0; i < 10; i++) {\n' +
      '        s += i;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['arithmetic'],
    toolchains: ALL,
    ctx: 's32 widecnt(void);',
  },
  {
    sym: 'narrowcnt',
    src:
      's32 narrowcnt(void)\n' +
      '{\n' +
      '    s16 i;\n' +
      '    s32 s;\n' +
      '\n' +
      '    s = 0;\n' +
      '    for (i = 0; i < 10; i++) {\n' +
      '        s += i;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'arithmetic'],
    toolchains: ALL,
    ctx: 's32 narrowcnt(void);',
  },
  {
    sym: 'membwalk',
    src:
      'struct S { s32 id; u16 name[6]; };\n' +
      'void membwalk(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s32 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->name[i] = s->name[i];\n' +
      '    }\n' +
      '}',
    features: ['array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void membwalk(u8 *d, u8 *s);',
    proto: { membwalk: { returnsVoid: true } },
  },
  {
    sym: 'membnarrow',
    src:
      'struct S { s32 id; u16 name[6]; };\n' +
      'void membnarrow(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->name[i] = s->name[i];\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void membnarrow(u8 *d, u8 *s);',
    proto: { membnarrow: { returnsVoid: true } },
  },
  {
    sym: 'basefold',
    src:
      'void basefold(u8 *d, u8 *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        *((u16 *)(d + 4) + i) = *((u16 *)(s + 4) + i);\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'cast', 'pointer'],
    toolchains: ALL,
    ctx: 'void basefold(u8 *d, u8 *s);',
    proto: { basefold: { returnsVoid: true } },
  },
  {
    sym: 'sibwalk',
    src:
      'struct S { u16 a[6]; u16 b[7]; u16 c[9]; };\n' +
      'void sibwalk(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->a[i] = s->a[i];\n' +
      '    }\n' +
      '    for (i = 0; i < 7; i++) {\n' +
      '        d->b[i] = s->b[i];\n' +
      '    }\n' +
      '    for (i = 0; i < 9; i++) {\n' +
      '        d->c[i] = s->c[i];\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void sibwalk(u8 *d, u8 *s);',
    proto: { sibwalk: { returnsVoid: true } },
  },

  // WHERE A VALUE THAT SEVERAL PLACES NEED GETS ITS ONE HOME, in a function with no loop. The
  // `value-home` rows above are all loop-shaped or address-shaped: `/addr-home` homes a base
  // dereferenced at 2+ sites, `/expr-home` homes a pure value defined outside a LOOP, and
  // `/derived-home` homes a pure value standing on a memory READ (rank.ts:128-164, all three
  // gated in structure/analysis.ts). Nothing homes a plain computed value shared by two BRANCH
  // ARMS, or a parameter's narrowing re-spelled at every use — and both are what a bit-test
  // prologue is made of.
  //
  // Cut from sa3:sub_802DFC8:agbcc (62) and sa3:sub_803213C:agbcc (48), the two rows this family
  // was written to explain. Both are m2c MATCHes; both were tagged `['struct','field']`, and that
  // attribution is FALSIFIED — starting from asmlift's own winning source and changing only the
  // three homes below, 802 reaches 0 (`rows=128`) and 832 reaches 0 (`rows=71`) while still
  // carrying asmlift's synthesized `struct Struct0 { s32 field_0; u8 _pad0[4]; … }`, its `field_N`
  // member names, `16 - 17` for -1 and the raw `(-(x)|x)>>31 & C` branchless idiom. asmlift's
  // struct-pointer field recovery on those rows is already byte-perfect (offsets
  // 0/8/12/14/20/22/26/27/28/31/32, every width right).
  //
  // The 8-subset lattice, every cell compiled through the row's own scoring context and scored
  // against its own target — A = the narrowed-parameter home, B = the merge-init (802) / cross-arm
  // expression (832) home, C = the base local. RESIDUAL score per subset, so 0 is a match:
  //   802: {} 62 · A 46 · B 23 · C 58 · AB 4 · AC 42 · BC 19 · ABC 0  → Shapley 17.5 / 40.5 / 4.0
  //   832: {} 48 · A 39 · B 15 · C 46 · AB 2 · AC 38 · BC 13 · ABC 0  → Shapley 10.8 / 35.3 / 1.8
  // No subset closes either row — v(AB) is 58 of 62 and 46 of 48; only all three reach 0. A cell
  // moves by ±1 when the repair is spelled differently, so read the split as ≈17/≈40/4 and
  // ≈11/≈35/2; the ordering, v(AB) and "struct/field recovery is worth ZERO" do not move.
  //
  // A FOURTH DEGREE OF FREEDOM the class names hide: WHERE each home sits RELATIVE TO THE OTHERS
  // — and the two rows want OPPOSITE answers. On 802 the merge-zero `s32 v0 = 0;` must sit ABOVE
  // the narrowing home `s32 t0 = (s16)a0;`; put it below and `mov r5, #0x0` lands two instructions
  // late, for 3. On 832 the shared constant `s32 v0 = 1;` must sit BELOW both narrowing homes; put
  // it above and `mov r6, #0x1` lands four instructions early, for 2. What does NOT matter on 832
  // is the spelling: the hoisted expression reading a literal `1` and reading the shared `v0` both
  // score 0. A home lever picks a PLACE, and "the top of the body" is a place it can pick wrong in
  // either direction.
  //
  // WHAT m2c DOES INSTEAD, and it is one mechanism, not three. m2c binds every register write to a
  // named `Var` (`translate.py:3503-3577` `_eval_once`, the name minted at translate.py:3546), so
  // a value used twice is EMITTED as `temp_rN = …;` and referred to. Its 802 output declares
  // `s16 temp_r1;`, assigns `temp_r1 = direction;`, then tests `8 & temp_r1` — the entry `lsl/asr`
  // given a name — and carries `var_r5 = 0;` above the chain. asmlift re-DERIVES an expression at
  // each use instead, which is why the same three homes are missing at once.
  //
  // THE ROWS. Every score below is a round-trip: compile the reference with the benchmark's own
  // agbcc, run the CLI on the produced `.s` and `--score-against` the produced `.o`. All seven
  // score with 0 dropped candidates and none declines, so no number here stands in for a frontend
  // link.
  //
  //   `sxparam` diff:19 — an `s16` parameter tested at three sites. agbcc extends it ONCE at entry
  //   (`lsl r0,#0x10 / asr r2,r0,#0x10`) and all three tests then read r2 with the constant in the
  //   other operand; asmlift declares `u32 a0` and re-spells `(s16)a0` at each use, which agbcc
  //   ELIDES (an `& 8` does not care) — so the extended value never gets a register of its own and
  //   the stream instead pays `add r2,r0,#0` at entry, `add r0,r2,#0` to read it back, and a
  //   different allocation from there on. FIVE-RUNG LADDER, all compiled against this row's own
  //   target:
  //     19  asmlift today
  //     16  the same source with ONLY the home added (`s32 t0 = (s16)a0;`)
  //      2  …and the now-redundant inner narrowing dropped (`-(t0 & 2)` for `-(s16)(t0 & 2)`)
  //      0  the home given the NARROW type (`s16 t0 = (s16)a0;`)
  //      0  the parameter declared `s16`
  //   The two middle rungs are what a builder needs: the capability is a home that CARRIES THE
  //   WIDTH, or an s32 home plus the cast-cleanup a width-carrying home makes automatic. (On the
  //   real rows the s32 home alone is enough — their re-spellings are not nested inside a cast.)
  //   `zxparam` diff:8 is the unsigned side (`lsl #0x18 / lsr #0x18` once per parameter): 8 today,
  //   and 0 for the homed `u8` temp, the homed `s32` temp AND the declared `u8` parameter alike.
  //
  //   `armexpr` diff:35 — a pure expression the source computed ONCE above an `if`, whose only
  //   consumers are the two arms. asmlift sinks it into BOTH arms and agbcc does not re-hoist:
  //   compiled pair, the pre-branch spelling emits the 8-instruction `mov/and/neg/orr/asr#31/mov/
  //   lsl/and` chain once in the entry block, the per-arm spelling emits that entire chain TWICE,
  //   once per arm. Homing it above the branch scores 0 — but ONLY with the signed parameter
  //   asmlift's winner already declares (its label is `signed`): spelled `u32`, agbcc constant-
  //   folds the whole `>>31` idiom to `mov r3, #0x0` and the same repair scores 18. The lever is a
  //   home, not a re-typing, and it must not disturb the signedness the ranked candidate picked.
  //
  //   `maskchain` diff:21 — `s32 m = 0;` above a four-arm chain whose arms conditionally overwrite
  //   it. asmlift re-materializes the 0 as an `else { v0 = 0; }` arm in three places and agbcc
  //   IF-CONVERTS each two-armed form into the branchless `neg/orr/asr #31/and` idiom the source
  //   never wrote — 4 `neg`s against the reference's 1. FIRST BLOCKER WATCHED FIRING, not inferred,
  //   then ABLATED: `structure.ts`'s anchorConstCopies declines any merge variable whose name is
  //   claimed by more than one SSA value (the `nameCount.get(name) !== 1` refusal at
  //   structure.ts:1766, documented in that block's REFUSAL CONDITIONS list), and instrumented it
  //   fires 48× on `v0` here. With that one condition ablated and the bundle rebuilt the row's
  //   ranked line goes from `best signed/defsite: 21` to a MATCH. `/defsite` IS enumerated here
  //   and wins the row — for the OTHER variable, the four-way `v`.
  //   On sub_803213C the same pass declines for a different documented reason, watched the same
  //   way: `v1` is CONSIDERED 288× and refused 288× on `opcode=or` plus 288× on `opcode=and` — the
  //   merge args there are an `or` and an `and`, not an unnamed `const`, so `/defsite` cannot reach
  //   `armexpr`'s shape at all. That is why the expression home is a separate row from this one.
  //
  //   `basecell` MATCH — ONE access through a numeric base at a nonzero byte offset. gcc 2.9
  //   folds a constant SUBSCRIPT into the pool word, so the inline cast compiles to
  //   `.word 0x3001103` + `ldrb r1, [r1]` where the pointer-local spelling keeps
  //   `.word 0x3001100` + `ldrb r1, [r1, #0x3]` (compiled pair, both dumped). `l3/basecse.ts`'s
  //   `single-use` gate rejected a base with `uses < 2` — its stated rationale, "one access
  //   re-materializes as cheaply as a named local", is false at a nonzero offset — so the offset
  //   the compiler did NOT fold rides as `BaseKey.unfoldedOffset` in a SECOND admission,
  //   `BASEFOLD_GATES`, which rank.ts offers as `/basefold` wherever the target declares
  //   `TargetDescription.compilerBehaviors.foldsConstAddrOffset`. A CANDIDATE and not a default,
  //   because the same bytes have a second source: agbcc keeps an aggregate MEMBER offset in the
  //   memory operand, so `((struct S *)0x3001100)->b` emits `.word 0x3001100` + `ldr [r0, #0x4]`,
  //   byte-identical to the named base (likewise a union member, and the write direction).
  //   asmlift can spell only one of the two, so the differ referees.
  //   The row is agbcc alone and holds the ADMITTED case; the refusals that keep the admission
  //   off the naive ablation below are gate-level, pinned in test/basecse.test.ts — an offset the
  //   ADDRESS carried rather than the memory operand (a relocation addend, a folded `add`, or an
  //   offset of 0, where the fold is the identity), a base of 0 (no literal for a subscript to
  //   fold INTO), and a target that declares no fold. A SYMBOL base reads the same rule off the
  //   same evidence: the bytes never agreed there either (`((u8 *)&gSym)[3]` emits
  //   `.word gSym+0x3` + `ldrb [r1]` where `gSym.d` and a named base both emit `.word gSym` +
  //   `ldrb [r1, #0x3]`), and `index.operandOff` is what carries the difference down from the lift.
  //
  //   `basehome` MATCH — THREE accesses through one base whose first use is not the function's
  //   first statement. The hoist fires here, but `l3/basecse.ts` emits every init at the head of
  //   `sfn.body`, so the base is live across the prologue and agbcc pays a callee-saved register
  //   for it: compiled pair, assigning at the top adds `push {r4, lr}` / `pop {r4}` / `pop {r0}` /
  //   `bx r0` where assigning at first use keeps a plain `bx lr`. LADDER: asmlift today (top) 11;
  //   NOT hoisting at all 9 (three fresh pool words, `.word 0x3001103` / `0x300110a` /
  //   `0x3001109`); assigning at the first use that needs it 0. The current placement is worse
  //   than no hoist, which is the same signal the real row gives — on sub_802DFC8 the inline
  //   spelling scores 4, a top-assigned base local 8, a first-use-assigned one 0, and asmlift's
  //   own `/livebase` candidate (which does emit the base local, at the top) scores 66 against the
  //   winner's 62. `l3/sinkinit.ts` is that placement, carried as the differ-refereed `/sinkinit`
  //   candidate rather than as basecse's own `[...inits, ...rest]` — taken as a DEFAULT the same
  //   move costs `mixpoll` and `onepoll` their matches, which is the ledger below. `l3/scopebase.ts`
  //   is the scope-aware sibling and does not help: the innermost enclosing scope here IS the
  //   function body. Eligibility and placement are the two halves of one question and both ride as
  //   candidates — `/basefold` and `/sinkinit`, paired over the admission roster.
  //
  //   `foldsink` MATCH — `basecell`'s single fold-evidence access placed in `basehome`'s position:
  //   ONE access through a numeric base at a nonzero byte offset, three statements down, so the
  //   two halves of the question are BOTH live and the row can only match if both are answered.
  //   LADDER, read off this row's own `[score]` table rather than off a hand-written variant:
  //   asmlift's inline cast 2; the base local assigned at the top of the body 9 — WORSE than not
  //   hoisting, the same signal `basehome` gives, and the reason a placement policy that picks
  //   wrong regresses rather than stalls; the base local assigned at its first use 0.
  //   IT DOES NOT BRACKET THE SUNK PLACEMENT. Measured through
  //   `compileTargetAsm`/`assembleTarget`/`decompileRanked` with `ASMLIFT_CANDCACHE=0`: the
  //   fan is 12 candidates and TWO spellings reach 0 — `/basefold/sinkinit` and `/offmember` — so
  //   `compareScored` settles it on `lineCount`, the member spelling has one line fewer, and the
  //   published winner is `unsigned/offmember`. Deleting the sunk admission would leave this row
  //   MATCH. `basecell` is the same story at the head position (`/offmember` 0 ties `/basefold` 0
  //   and wins the tie-break), which is why NEITHER old row puts a `basefold` token in a winning
  //   label and why a census over winning labels reads the family as dead. A TIE IS NOT A
  //   SUBSUMPTION: `foldhead` below is the same evidence answered where the two spellings are 0 and
  //   11, and there `/offmember` is not a tie but a worse program.
  //
  //   `foldhead` MATCH — `foldsink`'s shape with the DECLARATION carrying the initializer, which is
  //   the ordinary way a C source spells a base it uses once further down: the local is assigned at
  //   the top of the body and first read three statements later. It is the HEAD-position bracket,
  //   which nothing else in this corpus is. Read off this row's own
  //   `[score]` table (12 candidates, `ASMLIFT_CANDCACHE=0`): `/basefold` 0, `/basefold/sinkinit`
  //   11, `/offmember` 11, no lever at all 11 — so deleting the HEAD entry of
  //   `BASEFOLD_ADMISSIONS` costs this row its match while deleting the SUNK entry does not, which
  //   is the separation `foldsink` makes in the other direction.
  //   WHAT SPLITS THE THREE SPELLINGS, on compiled objects rather than on a theory: agbcc emits the
  //   pool words in the order the source materializes them and allocates the store's operands to
  //   match. The head-assigned local puts `.word 0x8024c35` first and stores `str r1, [r0, #0x4]`;
  //   the same local assigned at its first use, and the inline member cast, both put
  //   `.word 0x3001100` first and store `str r0, [r1, #0x4]`. So the claim in `basecell`'s
  //   paragraph that a member access is "byte-identical to the named base" holds only where the two
  //   spellings materialize the base at the SAME program point — move the assignment above the use
  //   and `/offmember` is a different program, which is why it rides beside this row and loses.
  //   THE SHAPE IS NOT SYNTHETIC-ONLY. Sweeping the agbcc checkouts one tree per function (2523
  //   thumb functions split out of `sa3/asm/*.s` and klonoa's `asm/`, 1762 lifted), the set
  //   `BASEFOLD_GATES` admits and `BASECSE_GATES` refuses is non-empty on 327 functions / 431 bases
  //   map-less and 272 / 365 map-ful, and on 141 of those bases (map-less; 142 map-ful)
  //   `/offmember` is refused outright — 83 of them by `no-operand-off`, because a sibling access
  //   at offset 0 through the same base leaves no displacement to read.
  //   RANKED, AND SAY THE CONFIGURATION — a sweep score quoted without one is not a weaker claim
  //   than one with it, it is a different claim. With the target
  //   assembled by hand from the checkout's own `.s` (`.syntax unified` prepended, else the
  //   unified Thumb mnemonics do not assemble) and ranked through the benchmark's own agbcc
  //   candidate compiler, `ASMLIFT_CANDCACHE=0`, BOTH configurations:
  //     kleod:InitPauseMenu             map-less 28 vs 30 ablated · map-ful 28 vs 30 — REPRODUCES,
  //                                     and it is the one function of the three the two
  //                                     configurations agree on.
  //     kleod:UpdateUIElementAnimation  map-less 102 vs 106 (runner-up IS `/offmember`) —
  //                                     REPRODUCES map-less; map-ful it is 99 vs 105, still won by
  //                                     `/basefold`, so the WIN survives the configuration and the
  //                                     numbers do not.
  //     kleod:StreamCmd_SetTimerAndMode map-less 11 vs 12 on this rig. A 17-vs-18 reading of the
  //                                     same function comes off a DIFFERENT target: 13 candidates
  //                                     either way, so the fan is identical and a hand-assembled
  //                                     object's pool alignment is not the project build's.
  //                                     MAP-FUL IT DOES NOT WIN AT ALL: 7 either way,
  //                                     `unsigned/inlinebase/volatile` with and without it.
  //   So the honest reading is a one-point edge on two functions in one configuration, not three
  //   wins. None of the three is a benchmark row; all of it is a rig artifact until re-run, and
  //   the row's own bracket (`synthetic:foldhead`) rests on none of it.
  //
  // THE CONTROL. `armkeep` MATCH — the same pure expression computed in BOTH arms, but consumed
  //   inside each arm rather than merged out of the `if`. agbcc keeps both copies, asmlift emits
  //   both copies, and the row matches. Hoisting it above the branch scores 9 against this row's
  //   own target, so a cross-arm home keyed on "the same pure expression appears in both arms"
  //   BREAKS it and the row says so. What it does NOT bracket: a home keyed on a MERGE VARIABLE's
  //   incoming values — nothing can, on this compiler. Measured, `if (a) { out[0]=0; m=(b<<3)+7; }
  //   else { out[0]=1; m=(b<<3)+7; } out[1]=m;` has its two copies SUNK by agbcc itself into the
  //   join block, so the ROM never carries the per-arm spelling for that shape and no reference
  //   source can produce it.
  //   Three further controls were drafted and DELETED, each because it cannot detect its own fix:
  //   `sxwide` (`out[0] = d; out[1] = d + 1;`) scores 0 in all four spellings — where the uses
  //   consume the FULL value agbcc CSEs the extension, so per-use and homed are the same program;
  //   `maskone` (`s32 m = 0; if (d & 2) m = 0x400;`) is if-converted, so it has no merge block and
  //   no `/defsite` candidate exists at all; `basefirst`'s first use IS its first statement, which
  //   makes top-placement and first-use placement the same tree. So no over-fire bracket for the
  //   WIDTH home exists anywhere in the corpus. What would earn one is a shape where the home
  //   forces a SPILL that per-use re-derivation avoids — unbuilt.
  //
  // WHAT ALREADY GATES THESE LEVERS (Phase 5, by ABLATION — the measure is whether a ROW moves,
  // not whether a test exists). Each ablation was applied to `packages/`, the bundle rebuilt, all
  // 887 rows re-run, and reverted. Read the regression columns first: two of the three levers pay
  // for their wins in lost matches, and both bills are on the REAL tier.
  //   `nameCount !== 1` off — 19 rows move, NONE of the 887 regresses. Synthetic (13): `mergeloop`
  //   agbcc 10→MATCH and mwcc_242_81 18→MATCH and gcc2.7.2kmc 18→7, `maskchain` 21→MATCH,
  //   `breakloop` kmc 11→5 and mwcc 15→14, `structarr` agbcc 5→2 and mwcc 45→44, `nestedloop` kmc
  //   16→13, `countdown` mwcc 23→18, `clampu8` kmc 6→5, `arraysum` mwcc 45→44, `powi` mwcc 32→31.
  //   Real (6): `sub_802DFC8` 62→23, `CalcCRC16` 38→23, `TrySetCantSelectMoveBattleScript` 192→146,
  //   `VramGetTotalAllocatedTiles` 18→7, `CountCollectedGems` 328→324, `ConfigureEntityBehavior`
  //   266→265. So the pre-existing `mergeloop` rows (tagged `merge-chain`) ALREADY gate this
  //   capability and are the stronger gate — two of them go all the way to MATCH, where
  //   `maskchain` is the non-loop isolate closest to the real rows. Zero regressions is NOT
  //   permission to delete the refusal: its rationale is that a shared name has readers and
  //   writers between the def site and the edge, a MEANING concern a score cannot referee. The
  //   lever is "refine the refusal", and 0 regressions bounds only its placement cost.
  //   `single-use` off (the `basecell` lever) — the NAIVE ablation, which is not what shipped:
  //   19 rows move, 7 better and 12 WORSE, and one of the twelve is a lost match. What shipped is
  //   a separate ADMISSION, narrower than the ablation and read by no committed path. Better:
  //   `basecell` 2→MATCH, `sub_803213C` 48→46 (exactly its
  //   v(C)), `GetInput` 68→58, `RollRandomLevelVariant` 24→18, `EntityItemDrop` 118→116,
  //   `ProcessInputAndUpdateEntities` 370→366, `CountCollectedGems` 328→327. Worse:
  //   `UpdateFadeEffect` MATCH→2, `readarm` MATCH→8 and `armshare` MATCH→17 (both `read-once`),
  //   `readcall` 6→17, `bg_mix` ido7.1 1→10, `dma_fill_uninit` 68→71, `StreamCmd_SetWindowRegs`
  //   5→15, `Sin2` 23→31, `ModifyStatByNature` 53→57, `Random` 7→10, `CalculatePPWithBonus` 17→19,
  //   `UpdateWorldMapNodeAnim` 159→162.
  //   placement → first use (the `basehome` lever), as a DEFAULT rather than the candidate that
  //   shipped — 8 rows move, 4 better and 4 worse. Better:
  //   `basehome` 11→MATCH, `DecompressDma` 19→3 (the largest single move any lever here makes),
  //   `sub_802DFC8` 62→58 (exactly its v(C)), `sa2__sub_8083504` 70→68. Worse: `mixpoll` MATCH→2
  //   and `onepoll` MATCH→2 (both `value-home`), `sizebound` 16→20,
  //   `ProcessInputAndUpdateEntities` 370→376.
  //   The two base levers INTERACT, so ship them together and re-measure rather than one at a
  //   time: with BOTH ablated 21 rows move, 11 better and 10 worse, `armshare` and `readcall`
  //   recover and `StreamCmd_SetWindowRegs` reaches MATCH, while `readarm`, `mixpoll`, `onepoll`
  //   and `UpdateFadeEffect` stay lost — net −1 match, against −2 for `single-use` alone.
  //   The `sxparam`/`zxparam` lever has no ablation (the capability does not exist yet), but two
  //   pre-existing rows already move under exactly its repair: `addu8` and `truncmul` (both
  //   `narrow`, both diff:4 on agbcc) reach 0 with the homed spelling AND with the declared narrow
  //   parameter. Expect those two to flip WITH this family's rows, as confirmation, not collateral.
  //
  // WHERE A FIX WOULD GO. `packages/core/src/structure/structure.ts` (anchorConstCopies'
  // single-claimant refusal, ~1766) and `structure/analysis.ts` + `rank.ts` for the home itself —
  // the three axes there are ONE capability gated on three incidental shapes, and this family's
  // remaining rows are exactly the cases none of the three admits. The two BASE rows are closed
  // (`l3/basecse.ts`'s BASEFOLD_GATES carries the eligibility, `l3/sinkinit.ts` the placement,
  // both as candidates), and what the ledger above still prices is the SYMBOL side of
  // `single-use`. No GATE can decide that side, and the reason is the unit rather than the data:
  // `Gate<BaseKey>` judges one key at a time, and the key the relaxation would admit on the two
  // rows that move in opposite directions is the same key with the same facts —
  // `a:gCallbackQueue 4 true`, one use at offset 1, `singleCell`, not `inLoop`, not
  // `unfoldedOffset` — in BOTH symbol-map configurations, and both rows publish a map-ful winner.
  // Their censuses are NOT identical (2 keys against 5 map-less, 2 against 3 map-ful), so a
  // predicate over the whole census is a different question this has not answered. The open
  // experiment is narrower than either: `UpdateWorldMapNodeAnim`'s two map-less-only keys are the
  // only `reachedOnce` keys in the pair that are not `singleCell`, so refusing THOSE would admit
  // `gCallbackQueue` alone on both rows — if 159→162 is carried by them and not by it, the win
  // survives and the loss does not. Run that before assuming this side needs a candidate.
  // The per-site-signedness round that shares two of those files has LANDED (5df7ced) and this
  // family is measured on top of it: all seven synthetic rows and both real rows score identically
  // before and after, and its structure.ts hunks (577, 1648, 1976-2048, 2221) do not touch
  // anchorConstCopies. Nothing here needs `l3/typing.ts`, `backend/cfamily.ts` or `rank.ts`'s
  // `SIGN_CANDS` either: every `signed/` candidate scores identically to its `unsigned/` twin on
  // all 24 of 802's and all 4 of 832's, so the signedness axis contributes zero on both real rows.
  //
  // NO NEW TAG, and one was tried: `param-width`, on the theory that asmlift must consume
  // `FnProto.params`' typed list. Handing asmlift the exact declared types via
  // `--proto '{"sub_802DFC8":{"params":["s16","Sprite *"],"returnsVoid":true}}'` returns the same
  // ranked line and byte-identical stdout, while homing the cast with no declared type anywhere
  // closes both real rows — so the gap is the home, not the types. The list IS read now
  // (raise/paramwidth.ts's `proto-width`), and it changes nothing here by construction: a
  // declaration only refuses a narrowing it CONTRADICTS, and `s16` is what this row's own prologue
  // extension already states. The rows carry the list anyway, so both decompilers hold the same
  // facts — the harness hands m2c the function's own prototype.
  //
  // m2c, on the identical `ctx` asmlift receives, MATCHES `sxparam` and NONCOMPILES the other six
  // — for two reasons, neither of them this family, and it REACHES the construct in every case.
  // (1) Five of the six (`zxparam`, `armexpr`, `armkeep`, `maskchain`, `basehome`) store through a
  // pointer PARAMETER at more than one offset and m2c renders those as `out->unk0` / `out->unk4`
  // on an `s32 *` it has no struct for — its documented raw-pointer member rendering, not context
  // withheld, since the `ctx` declares the full prototype, parameter names and all. (2) Two
  // (`basecell`, `basehome`) type the address constant as `void *` and read members off it
  // (`(void *)0x03001100->unk3`), as every raw-address row in this file already records; on
  // `basecell` that is the ONLY cause — its single store through the parameter renders as `*out`. What the output SHOWS is the point: on `armexpr` m2c hoists the
  // whole chain above the branch (`var_r2 = …;` then `if (a != 0)`), on `armkeep` it keeps BOTH
  // per-arm copies exactly as the reference wrote them, on `maskchain` it emits `var_r1 = 0;`
  // above the chain, and on `zxparam` it declares `u8 temp_r0;` and assigns `temp_r0 = a;`. Every
  // home this family is about, m2c has — and on `armkeep`, so does the restraint not to use one.
  //
  // agbcc only, as the `read-once` family is (`uninit-local` is NOT — it spans all four
  // toolchains, so it is no precedent). Every claim above is a pair of
  // spellings compiled with THIS compiler; whether ido7.1, gcc2.7.2kmc and mwcc_242_81 place a
  // parameter's extension, a merge initializer or a base local the same way was NOT measured, so
  // those lanes are left off rather than assumed. What would earn one: the same compiled pair on
  // that toolchain showing the same divergence.
  {
    sym: 'sxparam',
    src:
      'void sxparam(s16 d, s32 *out){ s32 v;' +
      ' if (d & 8) v = 6; else if (d & 4) v = 4; else if (d & 2) v = 2; else v = 0;' +
      ' out[0] = v; }',
    features: ['value-home', 'sign-extend', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void sxparam(s16 d, s32 *out);',
    proto: { sxparam: { params: ['s16', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'zxparam',
    src: 'void zxparam(u8 a, u8 b, s32 *out){ out[0] = a & 1; out[1] = b & 1; out[2] = a + b; }',
    features: ['value-home', 'zero-extend', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void zxparam(u8 a, u8 b, s32 *out);',
    proto: { zxparam: { params: ['u8', 'u8', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'armexpr',
    src:
      'void armexpr(u32 a, u32 b, s32 *out){\n' +
      '  s32 m = (b & 1) ? 0x400 : 0;\n' +
      '  if (a != 0) { out[0] = 0; } else { out[0] = 1; m |= 0x200; }\n' +
      '  out[1] = m;\n' +
      '}',
    features: ['value-home', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void armexpr(u32 a, u32 b, s32 *out);',
    proto: { armexpr: { params: ['u32', 'u32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'armkeep',
    src:
      'void armkeep(u32 a, u32 b, s32 *out){\n' +
      '  if (a != 0) { out[0] = (b << 3) + 7; }\n' +
      '  else { out[1] = (b << 3) + 7; }\n' +
      '}',
    features: ['value-home', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void armkeep(u32 a, u32 b, s32 *out);',
    proto: { armkeep: { params: ['u32', 'u32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'maskchain',
    src:
      'void maskchain(s32 d, s32 *out){\n' +
      '  s32 m = 0, v;\n' +
      '  if (d & 8) { v = 6; m = (d & 1) ? 0x400 : 0; }\n' +
      '  else if (d & 4) { v = 4; if (d & 2) m = 0x400; if (d & 1) m |= 0x800; }\n' +
      '  else if (d & 2) { v = 2; if (d & 1) m = 0x400; }\n' +
      '  else { v = 0; if (d & 1) m = 0x800; }\n' +
      '  out[0] = v; out[1] = m;\n' +
      '}',
    features: ['value-home', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void maskchain(s32 d, s32 *out);',
    proto: { maskchain: { params: ['s32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'basecell',
    src: '#define gStage 0x03001100\n' + 'void basecell(s32 *out){ u8 *p = (u8 *)gStage; out[0] = (p[3] != 7); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void basecell(s32 *out);',
    proto: { basecell: { params: ['s32 *'], returnsVoid: true } },
  },
  {
    sym: 'foldsink',
    src:
      '#define gStage 0x03001100\n' +
      'void foldsink(s32 a, s32 b, s32 *out){\n' +
      '  u8 *p;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p = (u8 *)gStage;\n' +
      '  out[2] = (p[3] != 7);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldsink(s32 a, s32 b, s32 *out);',
    proto: { foldsink: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'basehome',
    src:
      '#define gStage 0x03001100\n' +
      'void basehome(s32 a, s32 b, s32 *out){\n' +
      '  u8 *p;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p = (u8 *)gStage;\n' +
      '  out[2] = p[3]; out[3] = p[10]; out[4] = p[9];\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void basehome(s32 a, s32 b, s32 *out);',
    proto: { basehome: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'foldhead',
    src:
      '#define gStage 0x03001100\n' +
      'void foldhead(s32 a, s32 b, s32 *out){\n' +
      '  s32 *p = (s32 *)gStage;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p[1] = 0x8024C35;\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldhead(s32 a, s32 b, s32 *out);',
    proto: { foldhead: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },

  // HOW MANY LOCALS ONE BASE ADDRESS IS. Every base-local row above spells its base ONCE — a
  // file-scope `#define` (`dmafill`, `dmaptrsrc`, `dmavolsrc`, `dmaback`, `dmanest`) or one local
  // at the top of the function (`dmastride`, `dmafield`, `fieldbase`, `basecell`, `foldsink`,
  // `basehome`). This family is the case the source spells it N TIMES, once inside each region
  // that uses it, because a MACRO carrying its own local declaration was expanded N times — the
  // GBA `DmaSet` idiom, and the shape of every DMA macro in kleod's `include/gba/macro.h`:
  //     #define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4; \
  //       dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }
  // Each expansion declares its OWN `dmaRegs`, and on agbcc that is not cosmetic. A pseudo born
  // and dead inside one basic block is handled by `local_alloc` (agbcc/gcc/local-alloc.c:20-27,
  // "In this pass we consider only regs that are born and die once within one basic block ... Two
  // passes are used because this pass uses methods that work only on linear code, but that do a
  // better job than the general methods used in global_alloc"); one that spans the function falls
  // to `global_alloc`, whose priority is `floor_log2(refs)*refs / live_length`
  // (agbcc/gcc/global.c:604-624), so a long live range is allocated late and then HOLDS its hard
  // register through everything — and above r7 it is also a push/pop pair in the prologue, since
  // r4-r10 are call-saved (agbcc/gcc/thumb.h:405-411).
  //
  // IT IS THE COUNT OF DISTINCT LOCALS, NOT THE DECLARATION'S SCOPE — the decisive control, and
  // it is compiled. Take asmlift's winner C, sink the base assignment into each of the three
  // regions and un-merge the third store; holding it in ONE function-scope local scores 34,
  // and giving each region its own local scores 0. Declaring those three at FUNCTION TOP and
  // declaring them inside their blocks assemble to the SAME BYTES (`diff` of the two `.s`: empty),
  // so lexical scope is not the discriminator on this compiler and a block-scoped declaration is
  // not what closing this needs. One pseudo assigned three times is one long live range; three
  // pseudos are three, and only the second lets the invariant be hoisted into the preheader and
  // held across the loop (`ldr r2, .L12` above `.L4` and `str r0, [r2]` in both arms of the
  // matching build, against a fresh `ldr r3, .L12+0x4` inside each arm at 34). `dmascope2` says
  // the same at minimum size: one local assigned in both arms is 13, two locals one per arm is 0.
  //
  // The compiled lattice on `dmascope`'s own target — two independent axes, all six cells, every
  // point a real compile scored against it (`-O2 -mthumb-interwork -fhex-asm -fprologue-bugfix`),
  // all FIRST-IN from asmlift's OWN winner C so no number crosses a spelling basin:
  //
  //     base placement \ third store        MERGED below the arms    PER ARM
  //     bare cast at every use              40  (asmlift's winner)   36
  //     ONE function-scope local            39                       19
  //     N locals, one per region            30                       0  MATCH
  //
  // So it is a CONJUNCTION and the row exists to gate it as one, and the two conventions disagree
  // by more than 3x on each term — state which one any later number uses. The base-placement term
  // (bare cast -> N locals) is 10 FIRST-IN and 36 LAST-OUT; the un-merge term is 4 FIRST-IN and 30
  // LAST-OUT. The ONE-function-local row is a third point on the placement axis, not this
  // family's term.
  //
  // AND THE TERM IS ADVERSE WHERE IT WAS CUT FROM. Applied FIRST-IN to LoadBGTilemapData's own
  // ranked winner (386, its `/raw-globals` basin), giving each DMA region its own base local
  // scores 406 — twenty points WORSE, with every neighbouring divergence still in place. Pairing
  // it with the reference's read-back reads 401, still worse than the winner (the read-back alone
  // is 433). This family's OTHER term, the third-store un-merge, has not been priced on that
  // function at all. It pays only once the sibling divergences are gone; gate it here as a
  // conjunction term and never ship it as a default on its own evidence.
  //
  // NO REACH, censused on the candidate SOURCES asmlift compiled rather than read off a gate, and
  // on the invariant that actually discriminates: TWO DISTINCT LOCALS BOUND TO THE SAME BASE, one
  // per region. Across 188 captured `dmascope` candidate sources not one binds `0x040000D4` to
  // more than a single local; across 120 `dmascope2` sources 48 do bind two, and every one of
  // them is a function-top pointer PLUS the merge temp both arms assign identically — never one
  // per arm. The ASSIGNMENT alone does reach a region (80 of the 120 sink `v0 = (s32 *)67109076;`
  // into both arms), which is the 34-point spelling above and not the 0-point one. Nor does the
  // third store un-merge: all 188 `dmascope` candidates write it through a merge temp
  // (`…[2] = v1;`, spelled `p1[2] = v1;` in 136 of them) and 0 write the constant per arm.
  //
  // `dmascope1` is the CONTROL and asmlift MATCHes it (`best unsigned/volatile: 0 (match)`, 6
  // candidates): the same macro, the same base, expanded ONCE. Naming an MMIO base is not the gap
  // — counting it is. `dmascope2` is the minimal failing shape, one structural step from the
  // control: that same expansion in two disjoint `if` arms, and it already fails. `dmascope` is
  // the real function's shape — a loop whose two arms each expand the macro, plus a third
  // expansion after the loop — and it is where the conjunction above is measured.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, and the two counts are the family in one line: the
  // preprocessed reference declares FIVE `vu32 *dmaRegs`, one per DMA macro expansion
  // (`grep -c 'vu32 \*dmaRegs'` over it: 5), while asmlift's ranked winner (386,
  // `unsigned/flip-branch/defsite/merge-names/addr-home/expr-home/uns-cmp/livebase-block/volatile/
  // coalesce-v20-v14/initfirst/raw-globals`) declares ONE — `volatile s32 * p0;` at function top,
  // assigned once at the head of the body. One long live range where the source had five short
  // ones.
  //
  // WHAT THIS FAMILY DOES NOT MEASURE. Every probe here is read-back-free, and the reference is
  // not: all five of its expansions read `dmaRegs[2];` back and two of them poll it
  // (`while (dmaRegs[2] & (0x8000 << 16));`). So count-with-a-read-back is untouched here —
  // `dmascope1` shows base-count-alone is not the read-back class, and `dmaback` (17, open) holds
  // the other half; the JOINT shape, which is what the real function has, has no row on either
  // side. A read-back-carrying `dmascope` variant would be the row that earns it.
  //
  // Two neighbours describe placements that read like this one and are not: `armhomes` (MATCH) is
  // per-region homes for a MASK and loop invariants, one home per arm of an `if`, and `sizebound`
  // (nonmatch 8) is one base's init placed at its own scope while a second base's stays at
  // function top. Both are about WHERE one home goes; this family is about HOW MANY there are.
  // And NOT what `/livebase-block` names, whose label invites the wrong reading: `rank.ts:376-379`
  // gives `/livebase` and `/livebase-block` the same `placement: 'head'`, and "block" there is the
  // single-cell ELIGIBILITY gate, not a scope (`HoistPlacement = 'head' | 'first-use'`,
  // hoist.ts:121 — both function-scope). A winner carrying `/livebase-block` is not evidence that
  // the base count was considered.
  //
  // agbcc only. Every claim above is a pair of spellings compiled with THIS compiler; whether
  // ido7.1, gcc2.7.2kmc and mwcc_242_81 allocate N short-lived base pseudos differently was NOT
  // measured, so those lanes are left off rather than assumed. What would earn one: the same
  // compiled pair on that toolchain showing the same divergence.
  //
  // m2c noncompiles all three, on the identical `ctx` asmlift receives, and for the reason every
  // raw-address row in this file records rather than for anything in this family: it types the
  // address constant as `void *` and reads members off it (`(void *)0x040000D4->unk0 = ...`,
  // `invalid type argument of '->'`). It REACHES the construct in every case, and its output shows
  // it has the same two absences asmlift does — no base local anywhere (all three expansions
  // spelled through the raw constant) and the third store merged below the arms through `var_r0`.
  {
    sym: 'dmascope1',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope1(s32 n){ DmaSet(gTbl[n], gTbl[n + 1], 0x80000020); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope1(s32 n);',
    proto: { dmascope1: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmascope2',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope2(s32 n){' +
      ' if (gTbl[n] != 0) { DmaSet(gTbl[n], gTbl[n + 1], 0x80000020); }' +
      ' else { DmaSet(gTbl[n + 2], gTbl[n + 3], 0x80000040); } }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope2(s32 n);',
    proto: { dmascope2: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmascope',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope(s32 n){ s32 i;' +
      ' for (i = 0; i < n; i++) {' +
      ' if (gTbl[i] != 0) { DmaSet(gTbl[i], gTbl[i + 1], 0x80000020); }' +
      ' else { DmaSet(gTbl[i + 2], gTbl[i + 3], 0x80000040); } }' +
      ' DmaSet(gTbl[0], gTbl[1], 0x80000080); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope(s32 n);',
    proto: { dmascope: { params: ['s32'], returnsVoid: true } },
  },
  // TWO BASES IN ONE FUNCTION THAT WANT OPPOSITE HOMES: N REGION-LOCAL DEVICE BASES *AND* ONE
  // FUNCTION-SCOPE BASE THAT OUTLIVES THEM ALL. Two families each isolate one base and
  // one policy — `dmascope` (`/regionbase`) that a base spelled in N disjoint regions is N locals,
  // COUNT being the discriminator; `mixpoll` (`/livebase-block`) that one base bound at function
  // scope sits beside single-cell scalars that must stay inline, SELECTIVITY being the
  // discriminator. Real functions carry both at once, and asmlift's ranker admits a lever x lever
  // product only where a row demands it. This pair is that row and its over-fire control.
  //
  // THE ENDPOINT AND THE LATTICE. Every point below is a real compile of a hand-written spelling
  // scored against `dmapoll`'s own object with this agbcc (`-O2 -mthumb-interwork -fhex-asm
  // -fprologue-bugfix`) — ABSOLUTE scores of whole spellings, no lever added or removed between
  // two cells, so no FIRST-IN/LAST-OUT/Shapley convention applies to any of them.
  //
  //     DMA base \ the 0x03004000 base     LEFT INLINE   ONE function-scope local   PER REGION
  //     bare cast at every use                  69                  --                  --
  //     N locals, one per region                41                   0  MATCH           18
  //     ONE function-scope local                --                  11                  --
  //
  // 69 with neither hoist, 18 for a per-region reading of BOTH bases, 11 for a function-scope
  // reading of both — 0 only where the two policies apply to DIFFERENT bases. The composed
  // spelling is not a third invention: it is asmlift's own emitted `signed/regionbase/volatile`
  // source under one substitution, the three per-region locals for 0x03004000 collapsed into the
  // single head-assigned local `/livebase-block` already mints.
  //
  // WHAT THE ROW DEMANDS IS A CONJUNCTION, AND NEITHER HALF IS SEPARATELY WORTH BUILDING. asmlift
  // ranks 11 here today. A per-base region reading ALONE — DMA split per region, 0x03004000 left
  // inline — is the 41 cell. Today's whole-function region reading, composed with nothing, is the
  // 18 cell. Both LOSE to the 11 the ranker already finds, so a round that ships either half and
  // re-runs `dmapoll` reads 11 and cannot tell a wrong order from a wrong row. Only the pair
  // reaches 0. And no ORDER or PRODUCT of the two levers AS THEY STAND can spell it: on this
  // function `/regionbase` splits both bases (its emitted source mints `p0/p1/p2` for 0x03004000
  // as well as `p3/p4/p5` for 0x040000D4) and `/livebase-block` binds both at the head, so the
  // region reading has to become per-BASE first — a third degree of freedom neither lever has.
  // THE PAIRING LANDED AND THE PREDICTION HELD: `dmapoll` is MATCH on
  // `signed/livebase-block/homesplit-0x40000d4.4s/volatile` (l3/homesplit.ts) — the label names the
  // WITHHELD key, which is the device base — and the commit before it reads
  // diff:11 — the one-sided ablation, run rather than argued. `dmaflat` stays MATCH, which is what
  // the additive posture below buys. Every number in this block that is not marked PREDICTION is a
  // compile or a ranked run.
  //
  // A PER-BASE CHOICE OF REGION RULE IS NOT THE FREEDOM THIS ROW NEEDS, AND THE CENSUS IS WHY. The
  // obvious reading of "make the region reading per-base" is to let `hoistScopedBases` pick its
  // `RegionRule` per BASE KEY rather than per function. That choice has a ONE-ELEMENT DOMAIN here:
  // `SCOPEBASE_GATES`' `repeated-const-offset` is tallied over the KEY's uses, and both of this
  // function's bases repeat one — 0x03004000 reaches subscript 2 twice, 0x040000D4 reaches 0, 1 and
  // 2 three times each — so NEITHER key admits under `'whole'` and there is nothing to choose
  // between. Measured three ways that agree: `hoistScopedBases(sfn, { regions: 'whole' })` serves 0
  // keys on this row and on `dmaflat`; the ranked fan carries 0 `/scopebase` candidates on either;
  // and over 80 agbcc trees censused at the plan (11 synthetic — the nine core corpus fixtures plus
  // these two rows — and the 69 of 182 klonoa functions that lift map-less with no `--asm-data`),
  // the number of keys served under BOTH region rules is 0. Trees where `/livebase-block` homes two
  // or more keys, which is the population any pairing can reach: 3 of the 11 and 7 of the 69.
  //
  // AND EVEN WITH THAT GATE ABLATED THE PER-KEY READING CANNOT REACH 0, because WHERE the init
  // sits is a second axis this pass has no knob for. `hoistScopedBases` splices a region's init at
  // `Math.min(...r.uses.map((u) => u.idx[r.depth]))` — the first statement that uses it — which on
  // this function is index 1, below `v0 = 0`. The endpoint needs it at index 0, and the difference
  // is compiled: the composed spelling scores 0 with the 0x03004000 assignment at the very head of
  // the body and 2 with it one statement lower. `HoistPlacement: 'head'` is where that lives
  // (rank.ts LIVEBASE_ADMISSIONS), which is the OTHER lever — so the freedom that reaches 0 is not
  // which RULE a key gets, it is which key the head hoist WITHHOLDS.
  //
  // WHAT ASMLIFT DOES TODAY, AND WHAT EACH LEVER IS WORTH HERE — one ranked run of the row's own
  // target per cell. The instrument is a reversible source edit at the ONE site that produces the
  // lever (core is browser-pure, so no env switch can live there): the lever's own thunk in
  // `rank.ts` for `/regionbase`, its admission row for `/livebase-block`, `ablateHeuristic` from
  // `l3/gates.ts` for `region-single-use`, and a `rejects: () => false` stub for `single-cell`.
  //
  //                                   dmapoll                          dmaflat
  //     baseline                 56 cands, livebase-block/volatile 11   56, 0 MATCH
  //     `/regionbase` off        48 cands, 11                          48, 0 MATCH
  //     `/livebase-block` off    32 cands, livebase/volatile/sinkinit 12   32, 10
  //     its `single-cell` gate   32 cands, 12                          32, 10
  //     `region-single-use` off  56 cands, 11                          56, 0 MATCH
  //
  // `single-cell` and the whole `/livebase-block` admission give identical numbers, and the site
  // that makes them identical is the SHADOW at `rank.ts:1293`, not the gate table: neutering the
  // one gate leaves `LIVEBASE_BLOCK_GATES` binding exactly what `LIVEBASE_GATES` binds, so the
  // admission is refused before `hoistBaseLocals` runs. Watched with the ablation applied, all 52
  // of `/livebase-block`'s admission contexts on `dmapoll` report `shadowed=true` and it emits 0
  // labels, against 0 shadowed / 24 labels at baseline.
  //
  // The pair's live gate TODAY is the `/livebase-block` half, and it is the MATCH FLIP on
  // `dmaflat` (0 -> 10) rather than the single point on `dmapoll`. The `/regionbase` half is inert
  // on both rows until the pairing exists — nothing here can fail a `bench regression` on it.
  //
  // THE TWO-SIDED ABLATION THIS FAMILY CANNOT HAVE IS A THEOREM. Ablation only
  // REMOVES candidates; with no candidate carrying both labels the winner carries at most one, so
  // ablating the OTHER lever leaves the winner in the fan and `best` cannot move. On `dmapoll`
  // both levers genuinely reach — the fan loses 8 candidates one way and 24 the other — and `best`
  // still holds. The obligation the row carries INSTEAD is the compiled lattice above.
  //
  // THE OTHER LEVER LEAVES THE EXISTING ROWS UNMOVED FOR TWO DIFFERENT REASONS, AND ONLY ONE OF
  // THEM IS ABSENCE. A fan carrying no `/livebase-block` LABEL is not evidence that lever did not
  // run: `rank.ts:1293` refuses an admission binding the same bases at the same placement as an
  // earlier one, and `LIVEBASE_BLOCK_GATES` is `LIVEBASE_GATES` plus a REJECTS-ONLY gate, so
  // wherever `single-cell` rejects nothing the two tables admit the same set and the second is
  // shadowed. Watched at the two sites rather than read off labels: on `dmascope`/`dmascope2`
  // `/livebase-block` BINDS (104 admission contexts each) and is SHADOWED in every one — drop the
  // `/livebase` row from `LIVEBASE_ADMISSIONS` and 136 / 48 of its labels appear, so that is
  // REACH. On `mixpoll`/`onepoll`/`sizebound` `/regionbase` really does emit nothing:
  // `hoistScopedBases(sfn, { regions: 'per-region' })` returns null on all 18 / 18 / 48 of its
  // invocations. First blocker per key, printed from `firstRejection`: `region-repeated-const-
  // offset` on every key of `mixpoll` and `onepoll`; on `sizebound` that on two keys and
  // `region-single-use` on the third. `dmascope1` refuses on `region-single-use` too — not on
  // `regions-degenerate`, which `firstRejection` short-circuits before reaching.
  //
  // `dmaflat` IS THE OVER-FIRE CONTROL, AND WHAT IT CANNOT SEE MATTERS AS MUCH AS WHAT IT CAN.
  // Same body, same two bases, same three IWRAM cells; the DMA declaration is lifted out of the
  // macro to function scope, so the source spells ONE device base for the whole function. agbcc
  // distinguishes them: 9 pool words with 0x040000d4 twice for `dmapoll`, 8 with it once here.
  // Scored across the same spellings the table inverts exactly —
  //     both bases at function scope    11 vs dmapoll.o    0 vs dmaflat.o
  //     composed (DMA per region)        0 vs dmapoll.o   13 vs dmaflat.o
  //     both bases per region           18 vs dmapoll.o   18 vs dmaflat.o
  // — so a pairing firing on shape rather than on the source's declaration count costs it 13, BUT
  // ONLY IF THAT PAIRING IS NOT ADDITIVE. Shipped the way every lever in this repo ships, as one
  // more candidate in the fan, the composed spelling loses 13 to 0 and the MATCH survives: a green
  // `dmaflat` is NOT evidence a pairing did not over-fire. The row is live against a pairing
  // implemented as a REWRITE, or one that wins an equal-score tie, and against nothing else.
  //
  // WHAT THE PAIRING COSTS, AND WHERE. It is enumerated per ADMITTED KEY that survives the per-key
  // table (which key the source homed is not derivable), on the FIRST roster row binding those
  // bases at that placement — so the ceiling is three withholds, `homesplit-fan-cap`, and the floor
  // is 0. `synthetic:dmapoll` and `synthetic:dmaflat` sit at the ceiling for two bases: both
  // withholds admit, 16 of each row's 72 candidates. `synthetic:dmascope` is unmoved at diff:9 but
  // STOPS BEING a lever-clean control for `/regionbase`: the pairing pipes THROUGH that pass, so 36
  // of its 260 candidates bind the DMA base three times too — and they ride `/livebase`, not
  // `/livebase-block`, whose identical census at the same placement makes it the second label on
  // one program. Of the three bases bound there exactly ONE withhold admits: the region rule splits
  // neither of the others (`homesplit-no-region`). That is why test/regionbase.test.ts asks about
  // the PASS rather than the label. `synthetic:dmascope2` (diff:13) stays lever-clean: its census
  // is one key, so the pairing is degenerate there and contributes no candidate at all.
  //
  // NEIGHBOURS THAT READ LIKE THIS AND ARE NOT. `armhomes` (MATCH) is per-region placement with
  // exactly ONE decision to get right; `sizebound` (8) has two bases but one axis, WHERE one init
  // goes, not two policies. And `rank.ts:378` gives `/livebase` and `/livebase-block` the SAME
  // `placement: 'head'`: "block" is an eligibility gate, not a scope.
  //
  // NO EXISTING ROW COVERS THIS, censused at the SITES rather than off the labels. Building every
  // agbcc synthetic row's target and enumerating it: 212 rows enumerate, 8 decline on unrelated
  // links (`uhalf`/`utag` overlapping struct fields, three `preupdate_*` do-while pre-update,
  // `lladd`/`llsub` unmodelled `adc`/`sbc`, `stkarg` stack-as-data) and 0 targets fail to build,
  // the two failure modes counted apart. Fans carrying BOTH LABELS: 2, these two
  // rows. Rows where BOTH ADMISSIONS BIND: 4 — these two plus `dmascope` and `dmascope2`, where
  // `/livebase-block` is shadowed. So no existing row can change outcome when the pairing changes
  // TODAY. PREDICTION: `dmascope`/`dmascope2` are where a product
  // starts enumerating the moment one exists, so re-run them with the pairing and stop reading
  // either as a lever-clean control after; falsified by their fans carrying no candidate with both
  // labels on the commit that ships it. On the `/regionbase` side the census is already a reach
  // count — no row in the tier holds a `/regionbase` tree whose labels the source dedup eats.
  //
  // CUT FROM kleod:LoadBGTilemapData:agbcc, AND `dmapoll` DEMANDS STRICTLY MORE THAN IT DOES.
  // Enumerating all 117760 of that function's candidates: `/regionbase` splits 0x040000D4 into
  // three locals and leaves 0x03003430 at ONE, while `/livebase-block` binds each of the two at
  // one — so there the second base is one the first lever declines to split and the policies need
  // only not collide. On `dmapoll` `/regionbase` splits BOTH into three locals each, so they must
  // be ASSIGNED PER BASE. Of the 8 map-less klonoa functions inhabiting both levers, 6 carry the
  // shape — a base `/regionbase` splits AND a different base only `/livebase-block` binds —
  // `LoadBGTilemapData`, `InitLevelFromROMTable`, `TransitionGameplayInit`, `TransitionGameOver`,
  // `UpdateOamSortOrder`, `EntityHitReaction`; `UpdateMenuCursorInput` (`/regionbase` splits every
  // base the other binds) and `UpdateStageSelectScreen` (its plan mints one local, splitting
  // nothing) do not.
  // Name the CONFIGURATION whenever those counts are quoted: they are the MAP-LESS enumeration
  // (9 `/regionbase`, 45 `/livebase-block`, 8 both, none of them benchmark rows) over 258 lifting
  // functions, while the harness's real rows and the canonical ranked command run MAP-FUL, where
  // it is 24 / 49 / 16, and WHICH SET a row inhabits is itself configuration-dependent. Exactly ONE
  // of the 16 map-ful BOTH inhabitants is a benchmark row — `kleod:UpdateCameraScroll`, `noncompile`
  // with no `candidateLabel`, its whole fan failing to build, so it can express no winner. The only
  // other row anywhere in the map-ful census is `kleod:UpdateHUDCounterDisplay`, and it is a
  // `/regionbase`-ONLY inhabitant there (map-less it is in neither set); it MATCHes on
  // `unsigned/defsite/flip-join/derived-home/scopebase-coalesce-v2-v4`, so its WINNER carries
  // `/scopebase` and not `/regionbase` even though its fan holds one. Neither closes the hole. The
  // PRE-EXISTING row census this pair fills stays 2 / 4 / 0; with these two rows in it the
  // winner-carries counts read 2 `/regionbase` / 6 `/livebase-block` / 0 both.
  //
  // The number to carry to LBG is a DEFICIT of 31, not a ceiling on available gain: `/regionbase`'s
  // own basin ceiling there is 417 against the 386 winner, so a composition must clear 417 before
  // it can tie. A price measured in one spelling basin does not cross into another.
  //
  // agbcc only, for the `dmascope` family's own reason and no new one: whether ido7.1,
  // gcc2.7.2kmc and mwcc_242_81 allocate N short-lived base pseudos differently from one
  // long-lived one was never measured (mwcc_242_81 also stays off per the `hipress` hazard policy
  // — a candidate compile has no timeout). Neither row carries a busy-wait poll, so the
  // branch-likely lift link the `mixpoll`/`onepoll` block cites is NOT this family's reason.
  //
  // m2c NONCOMPILES both on the identical `ctx` and `proto`, for the raw-address reason every such
  // row in this file records and not for anything in this family: `(void *)0x040000D4->unk0 = ...`
  // , `invalid type argument of '->'`, 1 compile error, 5 markers. It REACHES the construct in
  // both and homes NO base at all — and its output for `dmapoll` and for `dmaflat` is the SAME
  // text apart from the function name, so the distinction costing agbcc 13 bytes is one it does
  // not represent.
  {
    sym: 'dmapoll',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmapoll(s32 n){ volatile s32 *st = (volatile s32 *)0x03004000; s32 i; i = 0;\n' +
      ' do { gRows = gRows + 1; gCols = gCols + 2;\n' +
      '  if (st[0] != 0) { DmaSet(st[1], st[2], 0x80000020); }\n' +
      '  else { DmaSet(st[2], st[3], 0x80000040); gTiles = gTiles + 3; }\n' +
      '  i = i + 1; } while (i < n);\n' +
      ' DmaSet(st[4], st[5], 0x80000080); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmapoll(s32 n);',
    proto: { dmapoll: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmaflat',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      'void dmaflat(s32 n){ volatile s32 *st = (volatile s32 *)0x03004000;' +
      ' vu32 *dmaRegs = (vu32 *)0x040000D4; s32 i; i = 0;\n' +
      ' do { gRows = gRows + 1; gCols = gCols + 2;\n' +
      '  if (st[0] != 0) { dmaRegs[0] = (vu32)st[1]; dmaRegs[1] = (vu32)st[2];' +
      ' dmaRegs[2] = 0x80000020; }\n' +
      '  else { dmaRegs[0] = (vu32)st[2]; dmaRegs[1] = (vu32)st[3]; dmaRegs[2] = 0x80000040;' +
      ' gTiles = gTiles + 3; }\n' +
      '  i = i + 1; } while (i < n);\n' +
      ' dmaRegs[0] = (vu32)st[4]; dmaRegs[1] = (vu32)st[5]; dmaRegs[2] = 0x80000080; }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dmaflat(s32 n);',
    proto: { dmaflat: { params: ['s32'], returnsVoid: true } },
  },

  // WHICH BASE KEYS GET A LOCAL — A PER-KEY QUESTION THE ROSTER ANSWERS PER FUNCTION. l3/basecse.ts
  // hoists every key its gate table admits, so an admission is an ANSWER FOR THE WHOLE FUNCTION.
  // THE GAP THESE ROWS WERE AUTHORED FOR: with only `/livebase` (every key reached twice) and
  // `/livebase-block` (those minus the ones read at a single fixed offset, `single-cell`) on the
  // roster, a source that spelled ONE base as a pointer local and left a second one inline sat
  // between them with nothing on the roster between them. These three rows are that gap and its
  // two boundaries, one admission each. `/unfolded` (l3/basecse.ts, UNFOLDED_GATES) now fills it
  // and `unfoldpark` is a MATCH.
  //
  // THE DISCRIMINATOR IT TURNS ON WAS ALREADY IN THE VOCABULARY. `BaseKey`
  // (l3/basecse.ts) carries `unfoldedOffset`: agbcc folds a constant SUBSCRIPT into the literal it
  // materializes, so an offset that arrived in the MEMORY OPERAND instead got there because
  // something other than a subscript put it there — a named base local, or an aggregate member.
  // `((s32 *)0x0300343C)[0]` emits `.word 0x300343c` + `ldr [r0]`; `s32 *p = (s32 *)0x03003400;
  // p[15]` emits `.word 0x3003400` + `ldr [r0, #0x3c]`. The field now has TWO readers, and they ask
  // OPPOSITE questions of it: `BASEFOLD_GATES` EXEMPTS `single-use` on it (a base reached ONCE) and
  // keeps both placement heuristics, so it never reaches a key reached twice inside a loop, which
  // is why it did not close this gap; `UNFOLDED_GATES` keeps `single-use` and REQUIRES the field.
  // Requiring it instead of exempting on it is the gate `/unfolded` ships as — `/livebase`'s table
  // plus `folded-offset`.
  //
  // THE MATRIX, and it is why there are three rows and not one. Best score per admission over each
  // row's own fan, agbcc, candidate cache OFF.
  //         plain  /livebase  /livebase-block  /scopebase  /unfolded
  //  livepark   30     0             6              3           0
  //  foldpark   37     6             0              6           0
  //  unfoldpark 36     9             9              9           0
  // Each row is won by a DIFFERENT admission, and `/unfolded` is the one that wins all three —
  // which is what says the gap was SELECTION. It binds exactly what `/livebase` binds on
  // `livepark` and exactly what `/livebase-block` binds on `foldpark`, so on those two it is
  // offering an existing base set at its own placement rather than a set nothing else reaches.
  // What that costs is measured per row, not asserted: fan 28 → 32 on `livepark`, 34 → 34 on
  // `foldpark` and 36 → 44 on `unfoldpark`, ablated the way BASEFOLD_ADMISSIONS' note describes
  // (a temporary env read filtering the roster at its one use site), cache off.
  // `foldpark`'s 34 → 34 is a RENAME and not a spelling: the same source that
  // won as `signed/livebase-block/volatile/sinkinit` wins as `signed/unfolded/volatile`, because
  // the roster loop runs before the `/livebase ×` product loops and `seen` keeps the first label.
  //
  // WHAT EACH ROW ISOLATES.
  //   `livepark`   two bases, both wanted as locals, one of them read at a single fixed offset
  //                through a local (`cur[15]`). `single-cell` refuses that key, so the NARROW
  //                admission binds only the DMA base and lands at 6. MATCH under `/livebase`.
  //   `foldpark`   `unfoldpark` — NOT `livepark` — with that cell spelled INLINE at its folded
  //                address (`*(s32 *)0x0300343C`), the shape `single-cell` was written for. It is
  //                ONE edit from `unfoldpark` and TWO from `livepark`, because it keeps the
  //                `0x03002040` distractor line `livepark` does not have: asserted by command, not
  //                by eye — `sed 's/foldpark/unfoldpark/' | diff` against `unfoldpark`'s source
  //                shows only the fold, and against `livepark`'s it shows the fold AND the
  //                distractor. The WIDE admission binds the cell anyway and lands at 6. MATCH
  //                under `/livebase-block`.
  //   `unfoldpark` `livepark` plus ONE folded single-cell distractor the source left inline
  //                (`*(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;`). Now the two wanted keys and
  //                the unwanted one are on opposite sides of no gate the roster has: wide binds all
  //                three, narrow binds one, and both land at 9. The row is `livepark` plus one line
  //                — `sed '/0x03002040/d'` on its own source, with the symbol renamed, is
  //                `livepark`'s source exactly, and that scores 0 today. That is the measurement
  //                which says the gap is SELECTION and not "bind more".
  //
  // WHAT `unfoldpark` CAN AND CANNOT GATE, because a green row is not automatically a guard.
  // It IS the guard on `/unfolded`: ablate that one admission and the row goes MATCH → diff:9 at
  // fan 44 → 36. It was a guard on nothing before that admission existed, and the ablation that
  // backs THAT is the whole-roster one — `/livebase`, `/livebase-block` and the `/basefold` pair
  // together left the row at diff:9, unchanged. SCOPE IT: the 9 that survived was not the bare
  // tree's, it was `/scopebase`'s. Under that ablation the row's fan was `9 signed/scopebase`,
  // `9 unsigned/scopebase` and 36 for all six remaining candidates (`signed`, `signed/offmember`,
  // `signed/vol-store` and the unsigned mirrors), so removing `/scopebase` on top of it took the
  // row 9 → 36.
  // AND THAT DOES NOT MAKE IT A GUARD ON `/scopebase`, which is the shape a deletion round is
  // likeliest to be misled by. A deletion only ever REMOVES candidates, so the question is what
  // the row's fan holds WITHOUT the roster ablation, and there the two `/scopebase` candidates are
  // ties, not winners: `unfoldpark`'s fan is 44 candidates, `9 signed/scopebase` and
  // `9 unsigned/scopebase` among them, and its best over the 42 candidates carrying no `scopebase`
  // token is 0 — its own winner, `signed/unfolded/volatile-p1`. Deleting the plain `/scopebase`
  // roster entry moves this row by 0. The guard exists only in a tree that has
  // already lost the base-admission roster, which is a configuration no round proposes and
  // `bench diff` cannot run.
  // NOR IS IT THE ONLY ROW REACHING THE PLAIN ADMISSION, censused rather than asserted: over every
  // agbcc synthetic row, FIVE carry a plain `/scopebase` candidate — `dmascope` 12 of 260,
  // `livepark` 2 of 28, `foldpark` 2 of 34, `unfoldpark` 2 of 36, `dmastride` 2 of 18 — and on
  // every one of the five the best candidate carrying no `scopebase` token equals the row's own
  // best (`dmascope` 9, `livepark` 0, `foldpark` 0, `unfoldpark` 9, `dmastride` 0). Measured
  // through the harness with the plain respell ablated, all five are UNMOVED — same outcome, same
  // score, same label.
  // A SIXTH ROW REACHES IT AND WINS: `synthetic:sbscope`, in this file, under
  // `unsigned/fresh-merge/scopebase` at 0, going NONMATCH 11 with the plain respell ablated. So
  // the reaching population is six and the plain admission wins one of them. A CENSUS SENTENCE IN
  // A COMMENT EXPIRES THE MOMENT A ROW IS ADDED BESIDE IT — re-run it rather than reading it.
  // AND A ROW ADDED TO THE ROSTER EXPIRES IT TOO, not only a row added to the dataset: a fan count
  // is a fact about the roster it was taken under. Re-enumerated at this commit, candidates only:
  // `dmascope` 24 of 544, `livepark` 2 of 32, `foldpark` 2 of 34, `unfoldpark` 2 of 44,
  // `dmastride` 2 of 18 — the plain
  // admission is reached in the same five fans and the counts under it moved on two of them.
  // `sbscope` is NOT re-run here and its numbers above are the ones this file already carried: a
  // candidates-only rig that does not hand the row its `ctx` enumerates a fan of FOUR for it
  // against the harness's, so this rig cannot speak to that row. Quote the SCOPE with the number.
  // WHAT IS DELETABLE THERE IS THE ROSTER ENTRY, NOT THE PASS, and the two are one token apart:
  // rank.ts enumerates COALESCED variants of the same `hoistScopedBases` under
  // `/scopebase-coalesce`, and one of those wins a match — `kleod:UpdateHUDCounterDisplay:agbcc`,
  // MATCH on `unsigned/defsite/flip-join/derived-home/scopebase-coalesce-v2-v4`. So an exact-token
  // census of the plain admission never sees that row at all; a substring one does, and a deletion
  // aimed at `l3/scopebase.ts` rather than at `respell('/scopebase', …)` costs that match.
  // The two neighbour rows ARE guards on the roster, but on a CONFIGURATION and not on one lever
  // each, and naming one lever is what makes such a guard go vacuous. `/unfolded` binds the same
  // base on both, so a SINGLE-row ablation moves neither: `livepark` is MATCH with `/livebase`
  // alone removed and `foldpark` is MATCH with `/livebase-block` alone removed. It takes
  // `/livebase` + `/unfolded` to get `livepark` to diff:3 and `/livebase-block` + `/unfolded` to
  // get `foldpark` to diff:6, and under the whole-roster ablation both land on `/scopebase` at
  // those same 3 and 6. ADDING AN ADMISSION THAT REACHES A GUARD ROW CAN MAKE ITS ABLATION
  // VACUOUS WITHOUT CHANGING ANY PUBLISHED OUTCOME, which is why no gate in the order can see it:
  // re-run every ablation a comment quotes whenever the roster gains a row.
  //
  // WHAT THE ADMISSION REACHES AND WHAT IT COSTS, censused rather than argued: every agbcc row the
  // artifact carries, candidates only, no compiles, the entry off and on, comparing the md5 of
  // each row's sorted distinct-source set — and in BOTH symbol-map configurations, because with a
  // map every absolute pool constant lifts to a `gaddr` and a census run in one arm is blind to
  // the other. SEVEN rows gain candidates and ZERO lose one, the same seven in both arms:
  //   kleod:ProcessInputAndUpdateEntities  21120 → 23040 map-less   58752 → 62208 map-ful
  //   kleod:ConfigureEntityBehavior         1056 →  1248             1536 →  1728
  //   synthetic:dmascope                     496 →   544              496 →   544
  //   synthetic:dmaflat / synthetic:dmapoll   72 →    80               72 →    80
  //   synthetic:unfoldpark                    36 →    44               36 →    44
  //   synthetic:livepark                      28 →    32               28 →    32
  // Zero losses is the roster's additivity holding: the entry is appended, so no earlier row's
  // shadow decision moves and no source stops being emitted.
  // TWO SCOPES IN ONE TABLE, and the per-row figures are stable across them while the TOTALS are
  // not. The map-less arm is re-run at this commit over 363 agbcc rows (23 throw identically, 333
  // hash identically, 7 gain): corpus fan 45223 → 47411 distinct sources, +4.84%. The map-ful
  // column and its total, 81747 → 85471 (+4.6%), were taken over the 358 agbcc rows the artifact
  // carried before this family's last rebase and are NOT re-run here; the seven rows and the zero
  // losses are what reproduced in both. Either way the cost is CONCENTRATED —
  // `ProcessInputAndUpdateEntities`, the corpus's slowest row, takes +3456 of the map-ful +3724.
  // A SECOND POPULATION MOVES WITHOUT THE FAN MOVING: 21 rows carry `/unfolded`-labelled
  // candidates whose source set is byte-identical to the ablated arm's, `synthetic:foldpark` (4)
  // and `kleod:UpdateCameraScroll` (1024) among them. Those are renames, not spellings, and the
  // only thing they can move is a published `candidateLabel` — which is why the gate on this entry
  // is `bench diff`'s label field and not `bench regression`.
  // The one other guard that reads the field, `BASEFOLD_GATES`, reaches none of these keys: its
  // census is empty on all three rows here.
  //
  // CUT FROM kleod:LoadBGTilemapData:agbcc, where the same three-way split is 399 / 386 / 383 —
  // `/livebase` parks five bases, `/livebase-block` parks one, and parking exactly the two whose
  // offsets survived the fold is what a hand-compiled spelling reaches. NAME THE SET FROM THE FILE
  // AND NOT FROM THE SENTENCE: that hand-compiled 383 is the 386 winner plus one local, so it
  // carries THREE pointer-base inits — the two parked bases and the winner's own `/addr-home` walk
  // local — and a filter written from the two-base description measures a different set than the
  // spelling does. Both were counted, and the fan of 68,352 contained ZERO candidates with
  // EITHER, measured at both dedup sites over all 165,888 generated spellings. No stack of gate
  // ablations can produce it: `hoistBaseLocals` binds `admittedBases(sfn, gates)` wholesale and
  // the two tables are a chain, so ablation only ever widens. `unfoldpark` is that shape at
  // 15 lines.
  // BOTH TOTALS ABOVE ARE #138's (`84aa4222`) AND NEITHER WAS RE-RUN HERE: that function's fan was
  // 68,352 then and 112,896 at this commit, so the ZERO is a claim about generated spellings that
  // needs a fresh enumeration to restate. A total goes stale silently while the delta beside it
  // stays true — re-run one before budgeting against it, and stamp it when you cannot.
  // THE ADMISSION REACHES THAT FUNCTION, which is a census fact and not a score: on its default
  // structuring `UNFOLDED_GATES` admits exactly two keys, `0x040000D4` and `0x03003430`, where
  // `/livebase` admits five, `/livebase-block` one and `/basefold` none. Reaching and COMPOSING
  // are different facts and only the ranked command answers the second — that function is not a
  // benchmark row, so `regression` and `diff` are blind to it.
  //
  // agbcc only, and for a reason this family owns rather than the `dmascope` one it inherits:
  // `unfoldedOffset` is evidence only where the target declares
  // `compilerBehaviors.foldsConstAddrOffset`, and MIPS and PPC put the addend in the instruction by
  // construction (`lui`/`%lo`, `lis`/`ori`), so a surviving operand offset carries no information
  // there and rank.ts offers the row no such admission. The addresses are GBA absolute constants;
  // mwcc_242_81 also stays off per the `hipress` hazard policy (a candidate compile has no timeout).
  //
  // m2c NONCOMPILES all three, on the identical `ctx` and `proto`, for the raw-address reason every
  // such row in this file records and not for anything in this family: `(void *)0x040000D4->unk0 =`
  // , `invalid type argument of '->'`, 1 compile error. It does READ the discriminator — the folded
  // cell comes out as `*(s32 *)0x0300343C` and the unfolded one as `(void *)0x03003400->unk3C` —
  // and homes NO base at all, so its output for `livepark` and for `unfoldpark` is the same text
  // apart from the one distractor line, and the distinction costing agbcc 9 bytes is one it does
  // not represent.
  {
    sym: 'livepark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void livepark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  s32 *cur = (s32 *)0x03003400;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *out = cur[15];\n' +
      '    if (cur[15] > 0) {\n' +
      '      dmaRegs[0] = (vu32)cur[15];\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void livepark(s32 n, s32 *out);',
    proto: { livepark: { params: ['s32', 's32*'], returnsVoid: true } },
  },
  {
    sym: 'foldpark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void foldpark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;\n' +
      '    *out = *(s32 *)0x0300343C;\n' +
      '    if (*(s32 *)0x0300343C > 0) {\n' +
      '      dmaRegs[0] = (vu32)*(s32 *)0x0300343C;\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldpark(s32 n, s32 *out);',
    proto: { foldpark: { params: ['s32', 's32*'], returnsVoid: true } },
  },
  {
    sym: 'unfoldpark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void unfoldpark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  s32 *cur = (s32 *)0x03003400;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;\n' +
      '    *out = cur[15];\n' +
      '    if (cur[15] > 0) {\n' +
      '      dmaRegs[0] = (vu32)cur[15];\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void unfoldpark(s32 n, s32 *out);',
    proto: { unfoldpark: { params: ['s32', 's32*'], returnsVoid: true } },
  },

  // A DEVICE REGISTER WRITTEN INSIDE A LOOP, WITH NOTHING READING IT BACK. A store to a DMA
  // register is an EVENT: it must happen once per iteration, where the source put it. `volatile`
  // is what says so, and asmlift's rendering of a device address is a plain `*(s32 *)67109076 =`
  // — which at -O2 agbcc is free to promote. gcc's loop MEM-promotion keeps a loop-invariant
  // store's address in a register and writes it back ONCE after the loop; the four `str`/`strh`
  // the reference emits per iteration become one. Verified by compiling asmlift's own emitted
  // candidate: on `dmafill` the reference's loop body holds 4 stores and the candidate's holds 1
  // (the other three land after the `ble`), and on the `dmavolsrc` control both hold 4.
  //
  // WHY NO EXISTING ROW CATCHES IT, by a census of the artifact as it stood BEFORE the six rows
  // below existed (207 distinct synthetic syms today): of its 200 distinct synthetic rows, 22
  // reference a device register and 14 of
  // those also contain a loop — but 11 of the 14 carry a `while (dma[2] & 0x80000000) {}` wait
  // poll, whose read of the register file blocks the promotion outright. Of the three that do not
  // poll, `dma_fill_uninit` writes its registers BEFORE its loop, and `swmulti` and `offloop` each
  // read other memory inside it (`gEnts[idx].w`, `p[i]`), which blocks it too. A DMA FILL with no
  // wait — the shape `DmaFill16` expands to — was not in the dataset at all, and neither was a
  // bare device read-back: zero of the 200.
  //
  // THE TWO GAP ROWS WERE CONJUNCTIONS, AND EACH TERM IS PRICED. Both now MATCH, through three
  // levers admitted together — `/vol-store` (pin a fixed-address device store `volatile`),
  // `/unreduce` (delete the loop-carried accumulator and spell each read as its closed form) and
  // `/ptr-field` (declare a recovered word field `void *`) — plus the two PAIRINGS that are the
  // whole point of the family: `/vol-store/unreduce` closes `dmafill` and the triple closes
  // `dmaptrsrc`. The lattices below are rooted at asmlift's OWN plain `unsigned` candidate,
  // byte-identical to what `decompileRanked` emits — an absolute-address base, so one base spelling
  // throughout. V = pin the three stores, R = un-reduce, T = the pointer field.
  //   `dmafill`   000 35 · V 19 · R 34 · VR 0        Shapley V +25.00, R +10.00 (sum 35)
  //   `dmaptrsrc` 000 42 · V 27 · R 35 · T 42        Shapley V +18.17, R +11.67, T +12.17 (sum 42)
  //               VR 35 · VT 27 · RT 32 · VRT 0      first-in +15/+7/+0 · last-out +32/+27/+35
  // R ALONE IS A REGRESSION on `dmafill` (34 against the 30 the row published), and T alone is
  // worth exactly ZERO. Read first-in, either lever looks not worth building; read last-out, each
  // is worth 27–35 of a 42-point row. Quote the convention with the number.
  //
  // THE PRICES ONLY HOLD IN THE ABSOLUTE-ADDRESS BASIN, which is why the three levers are offered
  // on the BASE spelling rather than on whatever the row wins with. Bolting V and R onto the
  // `/nearbase` spelling each row used to publish lands at 24 on `dmafill` and 22 on `dmaptrsrc` —
  // better than the 30 and 40 they published, and not a match. Same edits, same compiler,
  // different basin.
  //
  // WHAT THE ROWS ISOLATE.
  //   `dmafill`    MATCH at `/vol-store/unreduce` — the minimum: three register stores and a
  //                     `volatile u16` fill source, the destination a pure induction expression.
  //                     NOTHING is read in the loop, so the promotion is available; V and R above
  //                     were the whole residual.
  //   `dmaptrsrc`  MATCH at `/vol-store/unreduce/ptr-field` — the same loop with the destination's
  //                     base read from a POINTER-typed field of a plain global. That read is what
  //                     makes the loop promotable in the first place (below), so this is the shape
  //                     the real function has.
  //   `dmavolsrc`  MATCH — the family's control, and it is THREE-sided. All three axes now SHIP,
  //                     so it brackets live levers rather than hypothetical ones: `/vol-store`
  //                     ties it at 0 (the qualifier is free here, and the volatility tie-break
  //                     publishes the qualified twin), `/ptr-field` offers a 44 that loses, and
  //                     `/unreduce` declines outright — its loop has no accumulator, the field
  //                     read having never left it. A lever that MOVES this row has overreached.
  //   `dmastride`  MATCH — the ADVERSE control for R, and the positive control for V. Its
  //                     reference strides the destination itself (`p = p + 64`), so the
  //                     accumulator asmlift emits is the RIGHT spelling and a lever that always
  //                     un-reduced would break it (23, measured as a default). `/unreduce` DOES
  //                     fire here and offers exactly that spelling, at 33; the row keeps its
  //                     MATCH because the lever is an ADMISSION and `compareScored` orders by
  //                     score, so the worse spelling simply loses. That is what this row now
  //                     proves. asmlift still wins it at `unsigned/livebase/volatile`.
  //   `dmaback`    17 — `dmavolsrc` plus ONE statement: `gDma[2];`, the bare read-back the GBA
  //                     DMA macros end with. asmlift emits IDENTICAL C for the two rows (`diff`
  //                     of the two renderings, modulo the function name, is empty). Restoring the
  //                     read in the candidate closes it to 0, with or without `volatile` on it.
  //   `dmanest`  MATCH — `dmavolsrc` nested in an outer loop. Different residual entirely, kept
  //                     here because it is the same construct: see the last block below.
  //
  // WHY `/volatile` COULD NOT REACH THESE ROWS, attributed by instrumenting the refusal rather
  // than by reading it. `rank.ts`'s `/volatile` declares a pointer LOCAL holding a numeric address
  // as pointing at volatile data, and `volatilePtrLocals` (l3/volatileptr.ts) returns null when no
  // local qualifies. A `console.error` on that return prints `volatilePtrLocals NULL sym=dmafill
  // locals=v0, v1, sp0` on both rows and never prints OK: their base spelling has no pointer local
  // at all, so that lever has nothing to qualify, and hand-writing the local it would need
  // (`volatile u8 *p0` with volatile derefs) scores 25 on `dmafill` against a closing 0. The
  // capability was ABSENT from the fan rather than losing in it — the whole fan was four labels,
  // `{signed, unsigned} × {plain, /nearbase}`, every one carrying `v0 = v0 + 64;` and none
  // carrying `volatile`. `/vol-store` is the answer, because it qualifies the ACCESS and needs no
  // local at all; what keeps it off ordinary memory is the target's own declared window
  // (`capabilities.deviceRegisters`), which is a REACH gate rather than a soundness one — over the
  // corpus it excludes a const-address store on 7 rows, and lifting it would move the fan on two
  // of them (`readarm` 6 candidates would become 8, `fieldbase` 14 would become 20 — 6 and 14 are
  // what they enumerate today), with no score and no outcome moving either way. `synthetic:ucmp:agbcc` prices the DEVICE-READ side of the same question and belongs to it
  // rather than here: qualifying the 0x3001048 its loop test reads costs that match 15, and
  // `/vol-store` never reaches the row at all (its stores go through a runtime address).
  //
  // THE COMPILER FACT UNDER `dmaptrsrc`, verified in both directions on six compiled probes, each
  // differing from its partner in ONE token. agbcc's -O2 sets `flag_strict_aliasing` (gcc/toplev.c,
  // the `optimize >= 2` block), so `c_get_alias_set` (gcc/c-common.c) gives each main-variant type
  // its own set and loop-invariant motion may move a load past a store of a DIFFERENT type. Load
  // type vs the loop's store type, and whether the load left the loop:
  //     s32   field  / s32 store   → stays        void * field / s32 store    → HOISTED
  //     u16   field  / s32 store   → stays        s32 *  field / s32 store    → HOISTED
  //     void * field / void ** store → stays      void * volatile / s32 store → stays
  // So it is POINTER-ness, not width and not the cast: a no-op `(s32)` cast on an `s32` field and
  // `(u8 *)` arithmetic on one both compile to the same bytes as the plain spelling. That matters
  // here because a decompiler cannot see it — `ldr` is `ldr` whether the word is a pointer or an
  // int — while `ldrh` betrays a `u16`. The consequence is second-order and it is what `dmaptrsrc`
  // measures: the hoist makes the destination a strength-reduced accumulator, which leaves the
  // loop body with no LOAD at all, which is what lets the promotion fire. The
  // trap is that asmlift's own candidate has ALREADY hoisted the read by hand, so in that basin
  // the declaration has nothing left to decide and prices at zero — which is the T +0 first-in
  // above. It is +35 last-out.
  //
  // `dmaback`'S DECLINE, ATTRIBUTED BY INSTRUMENTATION rather than by reading: a temporary
  // `console.error` on the filter at `packages/core/src/pattern/engine.ts:478` fires
  // `dce DROPPED use-less load` on `dmaback` and does not fire on `dmavolsrc`, which drops the
  // same three other ops (`add`, `shl`, `undef`) and no load. The load is eligible because
  // `isDceSafe` (packages/core/src/ir/opcodes.ts:290) admits any opcode with no `effects` flag,
  // and `load` has none — the flag set is exactly `astore call opaque store`. The read survives
  // the frontend (it is `%20: unk32 = load %13` in the raw IR dump) and is gone by the folded
  // one. The lever this row gates is therefore a type-directed one, not a new pass: a read of an
  // address the target calls a device register is an execution, so it must reach
  // structure.ts's `sideEffects` walk, which already emits exactly this shape for `call` and
  // `opaque`. Cardinal-rule work: the reference's loop body carries one more instruction than the
  // candidate's (`ldr r0, [r3]` after `str r6, [r3]`), and 17 points is what one dropped
  // instruction costs in a 14-instruction loop body.
  //
  // `dmanest` IS A DIFFERENT MECHANISM and is deliberately the family's smallest row. Its two
  // objdiff rows were `ldr r0, [r4, #4]` vs `[r4, #0]` and `.word 50345008` vs `.word 50345012`:
  // under nesting asmlift stopped rendering the element as a struct view (`((struct Elem0 *)
  // 50345008)[a1].field_4`, what it emits for `dmavolsrc`) and folded the field offset into the
  // base instead (`((s32 *)((a1 << 3) + 50345008))[1]`). CLOSED, and NOT in the pass the residual
  // names. Struct-array recovery is present, correct and general; what was missing sits one level
  // below it. `raise/struct-arrays.ts` refuses an element pointer that reaches a successor arg,
  // and the nesting makes the frontend mint a ring of block params around that pointer which feed
  // only each other and which no op reads — a ring `ir/simplify.ts`'s per-round reader scan could
  // never retire, each half counting as the other's reader. Attributed by instrumenting the
  // refusal: `NOTCLEAN block-arg-use op=cond_br` with `accesses=1 [load@4w4]` here against
  // `ACCEPT stride=8 offs=4:4` on `dmavolsrc`. Least-fixpoint liveness retires the ring; the guard
  // is untouched, and ablating it INSTEAD reaches 0 too but fans the row 28 → 36 — while ablating
  // it AS WELL is inert (26 either way), because a retired ring leaves the guard nothing to trip
  // on. The two are not the same edit: one removes the cause, the other removes a real hazard's
  // refusal and buys 8 spurious candidates.
  //
  // WHAT MOVED IS THE WHOLE FAN, NOT ONE CANDIDATE. `dmanest` goes from 28 candidates carrying the
  // folded spelling 28/28 to 26 carrying the struct view 26/26: the folded spelling is no longer
  // ENUMERABLE, and nothing reports a candidate never enumerated. "No second spelling exists for
  // the differ to referee" is false — the differ referees these two at 0 against 2.
  //
  // AND THE WINNING LABEL DID NOT MOVE AT ALL. `signed/vol-store/initfirst` before and after, at 2
  // and at 0, while the winning PROGRAM changed completely (615 → 559 source bytes, a folded pool
  // word for a struct view). `candidateLabel` names the LEVERS, not the program, so a label-keyed
  // check sees nothing here — the inverse of the #112 trap, where the label gained `/vol-store` and
  // announced a change of winner. Only the `source` byte field caught it in `bench diff`. Print the
  // fan and diff the winner's text; a label is not an identity in either direction. The claim that
  // holds about the recovery is
  // stronger and is a property of the RECOVERY: it takes the base from the observed pool word and
  // the field offset from the observed load displacement, so it reproduces the target's own split
  // by construction. Verified by lifting all three splits and scoring each against ITS OWN target:
  // `.word 0x3003430`+`[r0,#4]` → `((struct Elem0 *)50345008)[a0].field_4` 0; `.word 0x3003434`
  // +`[r0]` → `((struct Elem0 *)50345012)[a0].field_0` 0; `.word 0x3003430`+`[r0]` → base
  // 50345008 `field_0` 0. Where the target folded, the recovery folds; the folded RENDERING was
  // the lossy one, which is why removing it costs nothing (894 rows, 0 lost).
  //
  // THE COMPILER FACT OUTLIVES THE ROW. It falsified a premise this repo held in two places —
  // that `->field_N` and `[idx]` compile identically, so the differ cannot referee between them —
  // and both citations have since been corrected (`raise/structs.ts` states the conditional form;
  // `rank.ts`'s copy was an orphaned docstring and is gone, its signedness half now on
  // `SIGN_CANDS`). On agbcc the two do not compile identically, and the two passes are nameable.
  // The fold is TREE-level reassociation,
  // `((VAR+C1)+C2) → VAR+(C1+C2)` in `fold`'s `associate:` block (gcc/fold-const.c:4959, via
  // `split_tree` at :1226); a COMPONENT_REF never enters that arithmetic, because
  // `get_inner_reference` (gcc/expr.c:3929, called at :5444) hands back the bit position
  // separately and `plus_constant` (:5631) applies it to the already-expanded address, where
  // Thumb's `[reg,#imm]` absorbs it. So an index moves the offset into the POOL LITERAL and a
  // field leaves it in the LOAD DISPLACEMENT. Compiled both ways at field offset 4 AND at offset
  // 0, with an 8-byte struct and a 32-byte one: at offset 0 the two are byte-identical, so the
  // discriminator is a NONZERO field offset. It reproduces at a cast symbol base (`.word gRaw`
  // plus `#0x4`) but NOT at a real array declaration — `extern struct E gTab[]; gTab[i].f4` emits
  // a third form, `.word gTab` + `add r1,r1,#0x4` + `ldr [r0]` — so the divergence is
  // decl-vs-cast, and a price measured here does not carry to a `gaddr` array declaration.
  //
  // NO ROW for the third gap this investigation named — a folded `symbol+k` pool literal against
  // the reference's single `symbol` — and the reason is structural, not an omission: a synthetic
  // candidate has no ELF, so no symbol map is ever attached and a `gaddr` never forms. Only a
  // real-tier row can reach it.
  //
  // NO ROW for declaration order either, because one already exists: permuting the 14 declarations
  // of asmlift's own winning `dma_fill_uninit` candidate and recompiling gives 0 / 6 / 9 / 12 over
  // 40 random orders — one of them a byte MATCH — and the order asmlift ships sits at the worst of
  // the four, which is the 12 that row publishes. So `dma_fill_uninit` is the gate for that
  // capability and this family adds nothing to it.
  //
  // NO ROW for reusing ONE local across several disjoint loops, which is the largest single gap
  // the LoadBGTilemapData ladder priced. `coalesceCandidates` (l3/coalesce.ts) is documented as
  // "every legal SINGLE merge, each as its own tree", so a candidate carries at most one merge —
  // and it takes four to reach the reference's spelling there. The reason there is no row is
  // measured, not assumed. Two shapes reusing one counter across three and four disjoint
  // call-bearing loops both reach MATCH with EXACTLY ONE `coalesce-vN-vM` token, because
  // structure() already gives the loops fewer distinct locals than the reference has loops. A
  // third, writing arrays instead of calling, gets no `coalesce-` candidate offered at all —
  // agbcc strength-reduces its three loops apart, so the shared counter never survives into the
  // recovery. Two more, adding register pressure, decline on a pre-existing frontend link (`stack
  // pointer used as data`, frontend/thumb.ts:1492) that is not this family. Nothing under ~60
  // instructions needed a second merge. The gate is real-tier.
  //
  // m2c scores none of the six, on the identical `ctx` asmlift receives, and for two reasons
  // neither of which is this family and neither of which is context withheld. Five DECLINE: it
  // types the DMA source-address store as `*(? **)0x040000D4 = &unksp0;` and the `?` placeholder
  // is a gap. The `ctx` states the full prototype, parameter names and all, and the `?` is the
  // pointee type of a STACK slot, which no prototype supplies. `dmastride` instead NONCOMPILES,
  // because there its base is one recovered pointer rather than three absolute stores and it
  // renders the writes as `(void *)0x040000D4->unk0 = &unksp0;` — the `void *`-member spelling
  // every raw-address row in this file already records, and exactly what `dma_fill_uninit` (which
  // also writes `&tmp` to a DMA register) produces. Checked, because a family comment once rested
  // on a cross-reference nobody had opened.
  // It REACHES the construct in every case, and two of its renderings are worth recording. On
  // `dmafill` it recovers exactly the structure asmlift does, strength reduction included
  // (`var_r0 = (var_r2 << 6) + base;` … `var_r0 += 0x40;`), and spells the three register writes
  // through the same unpinned `*(s32 *)0x040000D8 =` — so BOTH terms of that row's conjunction
  // are shared exposure, it simply never gets scored. And on `dmaback` its output carries NO
  // read-back statement either — its whole `dmaback` rendering is character-for-character its
  // `dmavolsrc` rendering, modulo the function name. Both decompilers drop a device read whose
  // result nobody consumes.
  //
  // WHAT THE ADVERSARIAL ROUNDS FOUND, because the next round will build on these rows and the
  // premise the first one falsified was written in four files. `/unreduce` licensed moving a memory read into
  // a loop on the ground that "a write to a hardware register is not a write to any object a C
  // program declares, so such a loop cannot change what an ordinary read sees". The first clause
  // is true and the second does not follow: a DMA controller reads a control word and then WRITES
  // ORDINARY MEMORY itself. `dmaptrsrc`'s own reference ends every iteration with
  // `gDma[2] = 0x81000020` — bit 31 set, a 32-word transfer into `[DMA3DAD]` — so the loop this
  // family is ABOUT is exactly the loop the premise fails on. Modelled and executed, the admitted
  // candidate turned a clean destination walk into wild writes.
  //
  // The fix is not a bar, because barring costs this row's match and buys nothing: `dmaptrsrc`'s
  // reference really does read `gBg[bg].pTilemap` inside the loop, and the SOUND alternative —
  // the read hoisted into a local above the loop — compiles to 16, not 0, because a C statement
  // lands above the loop's ENTRY GUARD while the compiler's own invariant hoist lands below it
  // (both objects disassembled; the guard is the `cmp r2,#0x1f / bgt` the load moves across).
  // What ships instead is a target datum for the memory-model half (`deviceMemoryWriters`, the
  // four DMA channel-enable halfwords) and a PROOF requirement for what it cannot settle: the
  // spelling is published only at a byte-exact score and withheld everywhere else. On this row 4
  // of the 16 candidates are now withheld, all at 35, and the fan's two 0s are untouched — and
  // that count is in the row's own `withheldCandidates`, because a MATCH resting entirely on the
  // proof gate is not a thing an artifact should leave to prose.
  //
  // AND THE SECOND ROUND FOUND THE FIRST FIX'S SCOPE WRONG, which is the part to carry forward.
  // The premise was corrected and the GATES still asked about the loop, while the transform moves
  // the init across everything between where it stood and each read — plus the counter's start,
  // which is a second anchor and can stand on either side of the init. Three shapes were admitted
  // with no proof required and diverged on every input vector; the fuzz that reported zero could
  // not generate any of them, because its generator never emitted a statement between the two
  // inits. Neither row's spelling is affected — the region is empty on both — but a lever built on
  // these rows must state the span its gates range over, not the statement they happen to sit next
  // to.
  //
  // `/unreduce` CANNOT SEE `dmanest`'s LOOPS, and that is unrelated to what closed the row. They
  // are nested, and that pass walks TOP-LEVEL loops only (91 of the corpus's 189 loop-bearing
  // trees are in the same position), so a decline there names no gate. Widening the scan is a
  // prerequisite for any lever that wants those loops, not a side effect of one that does not.
  //
  // agbcc only, as the `read-once` family is (`uninit-local` and `value-home` are NOT — both span
  // all four toolchains, so neither is a precedent). Every claim
  // above is a pair of spellings compiled with THIS compiler; whether ido7.1, gcc2.7.2kmc and
  // mwcc_242_81 promote a loop-invariant device store, delete a use-less device read, or read a
  // field's pointer-ness in their alias analysis was NOT measured, so those lanes are left off
  // rather than assumed. What would earn one: the same compiled pair on that toolchain showing
  // the same divergence. `device-access` is on `dmaback` alone now — the one row left whose
  // residual turns on a device access. A row with no residual has nothing for a "the diff turns on
  // this" tag to be about (the rule that keeps `rereadctl` untagged in `read-once`), so `dmafill`
  // and `dmaptrsrc` carried it while they were gaps and lost it when they closed.
  //
  // Cut from kleod:LoadBGTilemapData:agbcc, whose inner loop is a `DmaFill16` with no wait and
  // whose reference source ends FIVE macro expansions in a bare read-back (`grep -c` over the
  // preprocessed reference: 5). SAID PLAINLY BECAUSE IT IS EASY TO ASSUME OTHERWISE: closing
  // these rows is not predicted to move that function. Its winner already declares the DMA base
  // `volatile s32 *p0` and its label already carries `/volatile` — `/addr-home` makes the base a
  // local there, so the reach problem this family measures does not arise. And the read-back gap
  // points the OTHER way on it: over a 16-point spelling lattice on that function, restoring the
  // five dropped read-backs is worth +7…+19 in the eight points that keep the reference's shared
  // loop counters and −29…−48 in the eight that split them, and asmlift's spelling is the split
  // one. `dmaback` is a fidelity row, priced, and the price on that function is negative.
  {
    sym: 'dmafill',
    src:
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmafill(s32 lo, s32 base){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)(base + i * 64); gDma[2] = 0x81000020; } }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void dmafill(s32 lo, s32 base);',
    proto: { dmafill: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmaptrsrc',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBg ((struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmaptrsrc(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBg[bg].pTilemap + i * 64); gDma[2] = 0x81000020; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void dmaptrsrc(s32 lo, s32 bg);',
    proto: { dmaptrsrc: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmavolsrc',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmavolsrc(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + i * 64); gDma[2] = 0x81000020; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void dmavolsrc(s32 lo, s32 bg);',
    proto: { dmavolsrc: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmastride',
    src:
      'void dmastride(s32 lo, s32 base){ s32 i; volatile u16 tmp;\n' +
      ' volatile s32 *d = (volatile s32 *)0x040000d4; s32 p = base + lo * 64;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; d[0] = (s32)&tmp;\n' +
      ' d[1] = p; d[2] = 0x81000020; p = p + 64; } }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void dmastride(s32 lo, s32 base);',
    proto: { dmastride: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmaback',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmaback(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + i * 64); gDma[2] = 0x81000020; gDma[2]; } }',
    features: ['device-access', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void dmaback(s32 lo, s32 bg);',
    proto: { dmaback: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmanest',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmanest(s32 lo, s32 bg, s32 n){ s32 i, j; volatile u16 tmp;\n' +
      ' for (j = 0; j < n; j++) for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + j * 2048 + i * 64); gDma[2] = 0x81000020; } }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void dmanest(s32 lo, s32 bg, s32 n);',
    proto: { dmanest: { params: ['s32', 's32', 's32'], returnsVoid: true } },
  },

  // ── THE MAP-ASKING AXES, and the synthetic rows that carry a map ──────────────────────────
  //
  // `/no-bitfield` keeps the honest shift spelling where the map would name a bitfield member.
  // Its enumeration gate (rank.ts, `mapHasBitfields`) reads `opts.symbols`, so a MAP-LESS row is
  // structurally incapable of producing one candidate for it, and a census over a map-less tier
  // measures the CORPUS rather than the axis.
  // What the corpus does contain is the fold's own five reach rows, all kleod:agbcc, and on all
  // five the fold ON wins — so a census reads the OFF arm as dead. These two rows are the shapes
  // the axis was built for, where it is the ONLY spelling that matches.
  //
  // WHY BOTH DIRECTIONS, AND WHAT EACH ROW ACTUALLY BRACKETS — two different things, and keeping
  // them apart is the point. The switch (`spellBitfieldMembers`) gates the READ fold (the
  // `(x << a) >> b` extract → `gPacked.dreamStones`) and the WRITE fold (the mask-and-insert →
  // `gPacked.dreamStones = v`) together.
  //
  // AT MATCH LEVEL, BOTH ROWS BRACKET THE SAME ONE-LINE DELETION: the `/no-bitfield` arm in
  // `bitfieldCands`. Delete it and `bfwordread` goes 0 → 1 and `bfwordwrite` goes 0 → 8. Both
  // numbers are read off THESE ROWS through the harness itself (`bench run --tier synthetic --only
  // <sym> --toolchain agbcc --serial`, `ASMLIFT_CANDCACHE=0`), control re-run beside each. TAKE
  // THEM OFF THE ROW AND NOT OFF A STANDALONE CLI PROBE: a probe of the write shape scores that
  // ablation 19, which is a different rig and not this row. So the second row buys no second
  // DELETION bracket — one row per direction is not what brackets the arm.
  //
  // AT LABEL LEVEL THEY DO SPLIT, and that is what the second row is for. Guard the WRITE fold's
  // `bitfieldStore.set` alone and `bfwordwrite` stays MATCH at 0 while its label moves
  // `unsigned/no-bitfield` → `unsigned`, with `bfwordread` untouched; guard the READ fold's
  // `bitfieldSpelling.set` alone and exactly the mirror happens. So each row responds to its own
  // direction and to nothing else — measured, one direction at a time, control beside each.
  //
  // THE CONSEQUENCE, stated because it is a gap and not a reassurance: deleting either FOLD is a
  // label-only change on these rows. `bench regression` reports 0 lost and would green-light it;
  // only `bench diff`'s `candidateLabel` field catches it. The folds' match-level cost is on the
  // REAL tier — PR #136 measured the write fold alone at `kleod:ProcessInputAndUpdateEntities`
  // 284 → 248, and that row is 211 in the artifact under later unrelated changes, so RE-DERIVE the
  // fold's own value rather than quoting either number — and nothing here brackets it. A row where
  // the fold ON is the only spelling that matches would,
  // and none is authored: on a source that really writes the member, both spellings compile to the
  // same bytes and the differ has nothing to referee.
  //
  // WHY AN `extern` GLOBAL RATHER THAN AN ADDRESS MACRO, which is the usual synthetic idiom here.
  // Measured both ways: build `bfwordread`'s body against `#define gPacked 0x03005220` and the
  // target's pool word is NUMERIC, so `/raw-globals` spells the same bytes through a plain
  // dereference-and-shift and takes the row outright — 3 candidates, `/raw-globals` 0,
  // `/no-bitfield` 1, the plain arm 2. Not a tie-break and not a near miss: the fold arm does not
  // reach 0 at all there, so the macro row would pin nothing about this axis. An `extern` makes
  // the pool word a RELOCATION, which only a map-fed spelling can emit, and the two map arms then
  // differ exactly on the fold. The price is one loud drop per SIGNEDNESS ARM the row enumerates
  // — `/raw-globals` fails candidate compilation, having no declaration to emit, so `bfwordread`
  // publishes 1 dropped candidate and `bfwordwrite` (which keeps both arms) 2 — the brief's
  // extern-data-global constraint biting the raw arm alone rather than the row.
  //
  // THE MECHANISM, on compiled objects rather than on a theory: for `u32 dreamStones : 7` seated
  // in the first u16, agbcc compiles the named read `gPacked.dreamStones` to `ldrh` at the
  // DECLARATION's access width; the source that loaded the whole WORD and shifted by hand emits
  // `ldr`. One instruction differs, and the differ referees it.
  //
  // THE m2c HALF OF BOTH ROWS IS A NONCOMPILE, AND THE MAP IS WHY. Told only the prototype, m2c
  // self-declares `extern s32 gPacked;` and its integer arithmetic compiles against that — a
  // MATCH. Handed the map — the same facts asmlift gets — m2c omits the declaration, as a
  // decompiler told about a symbol should, and emits the same integer arithmetic against the
  // struct: `invalid operands to binary <<` and `invalid operands to binary &`.
  // The counterfactual is measured and is in `eval/evaluate.ts`'s note beside the rung that
  // supplies the declarations: the SAME emitted body under m2c's own `extern s32 gPacked;` scores
  // 0 and matches. So the loss is m2c's output not compiling against the context m2c was given,
  // and it is the honest price of closing the channel rather than a capability claim.
  {
    sym: 'bfwordread',
    src:
      'struct Packed { unsigned hearts : 2; unsigned stars : 3; unsigned dreamStones : 7; unsigned pad : 20; unsigned unk4; };\n' +
      'extern struct Packed gPacked;\n' +
      'unsigned bfwordread(void){ return (*(unsigned *)&gPacked << 20) >> 25; }',
    features: ['cast', 'global'],
    toolchains: ['agbcc'],
    ctx: 'unsigned bfwordread(void);',
    symbols: PACKED_MAP,
  },
  {
    sym: 'bfwordwrite',
    src:
      'struct Packed { unsigned hearts : 2; unsigned stars : 3; unsigned dreamStones : 7; unsigned pad : 20; unsigned unk4; };\n' +
      'extern struct Packed gPacked;\n' +
      'void bfwordwrite(unsigned v){ unsigned *p = (unsigned *)&gPacked; *p = (*p & ~0xFE0u) | ((v & 0x7Fu) << 5); }',
    features: ['mask', 'cast', 'global', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void bfwordwrite(unsigned v);',
    proto: { bfwordwrite: { returnsVoid: true } },
    symbols: PACKED_MAP,
  },

  // `/scopebase` — WHICH SCOPE the hoisted base local is declared in. `l3/basecse.ts` hoists to
  // the function top, which for a base used only inside one `if` arm makes it live across
  // everything before that arm and allocates differently; `l3/scopebase.ts` declares it in the arm
  // instead. The axis also fixes an ELIGIBILITY hole, and this row exercises both at once: with
  // the map's array RANK the access renders as the bare `gBgTilemapBufs[0][i]`, whose base is a
  // `var` rather than an address expression, so `isHoistableBase` never offers it to `basecse` at
  // all and the scoped pass is the only route to a named base here.
  // TWO-SIDED, and the second side is why the row is worth its compile: the SAME source with the
  // declaration moved to the function top is a DIFFERENT object, and it is won by a different
  // label — so the two placements bracket each other rather than one dominating. Measured on this
  // row's own fan with `ASMLIFT_CANDCACHE=0`: `/scopebase` matches at 0 and the best spelling
  // without it is 11.
  // Like `bfwordread`/`bfwordwrite` this row carries a MAP, and for the same structural reason: run
  // map-less the fan carries zero `/scopebase` candidates, because the primary already hoists
  // `p0 = (u16 *)&gBgTilemapBufs;` to the function top and there is no `var` base to scope.
  {
    sym: 'sbscope',
    src:
      'extern unsigned short gBgTilemapBufs[4][1024];\n' +
      'void sbscope(int flag, int v){\n' +
      '  if (flag != 0) {\n' +
      '    unsigned short *p = gBgTilemapBufs[0];\n' +
      '    p[0x252] = v;\n' +
      '    p[0x272] = v + 1;\n' +
      '    p[0x292] = v + 2;\n' +
      '  }\n' +
      '}',
    features: ['array', 'global', 'pointer', 'branch', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 'void sbscope(int flag, int v);',
    proto: { sbscope: { returnsVoid: true } },
    symbols: TILEMAP_MAP,
  },

  // `/no-ptr-elem` — the OFF arm of `structure.ts`'s `ptrMemberElement`, which rewrites byte
  // arithmetic through a map-declared sized pointer member into the element spelling
  // (`((u16 *)gBgPtrs.pMap)[i + 157]`). IT IS AN AXIS AND NOT A PRIMARY, because the rewrite is
  // not free: compiled, the two spellings are the same address and the same instruction count and
  // DIFFERENT objects at a nonzero element offset, so the differ has to referee them. This row is
  // the side of it no corpus row exercises.
  // Measured on this row's own fan with `ASMLIFT_CANDCACHE=0`: the byte-arithmetic target is
  // matched at 0 by `/no-ptr-elem` and by nothing else. The map is required for the same reason
  // `bfwordread`/`bfwordwrite` need one — the axis is enumerated only where the map declares a
  // pointer member with a pointee width of 1/2/4, so a map-less tier produces zero candidates.
  //
  // IT PAYS TWO LOUD DROPS OF ITS OWN, for the reason the bitfield rows pay theirs — this row also
  // relocates against a named `extern` global, so `/raw-globals` has no declaration to emit and
  // fails candidate compilation on each signedness arm it enumerates. `synthetic:ptrelem`
  // therefore publishes 2 `droppedCandidates` (`unsigned/raw-globals`, `signed/raw-globals`)
  // permanently. The price is per SIGNEDNESS ARM and not per row, which is why `bfwordread` and
  // `bfwordwrite` publish 1 and 2 rather than two each. Read off the artifact: 1, 2, 2.
  // Stated here because it is stated there: an undocumented pair of standing compile failures in
  // the corpus is one nobody can tell from a new regression, and nothing in `apps/benchmark` gates
  // a corpus-wide drop count.
  //
  // ITS m2c HALF IS A STANDING NONCOMPILE, before the map channel and after it, so this row is no
  // part of that channel's price. Measured through `evaluate()` with both caches off. Told only
  // the prototype, m2c emitted `(gBgPtrs + (i * 2))->unk13A` and failed with `invalid type
  // argument of '->'`; told the map, it emits `gBgPtrs.pMap[i].unk13A` — better, and the member
  // selection is now on the right object — and fails with `request for member 'unk13A' in
  // something not a structure or union`, `pMap` being a `u16 *`. Recorded to keep this row out of
  // the map channel's price: `invalid operands to binary <<` is `bfwordread`'s error, and not one
  // this row has ever produced.
  {
    sym: 'ptrelem',
    src:
      'struct BgPtrs { unsigned short *pMap; unsigned pad; };\n' +
      'extern struct BgPtrs gBgPtrs;\n' +
      'unsigned short ptrelem(int i){ return *(unsigned short *)((i << 1) + (unsigned char *)gBgPtrs.pMap + 314); }',
    features: ['pointer', 'global', 'cast'],
    toolchains: ['agbcc'],
    ctx: 'unsigned short ptrelem(int i);',
    symbols: BGPTRS_MAP,
  },
  // ── GLOBAL ARRAY SHAPE — the base local, the array-typed subscript, and the pool addend ────────
  // Seven rows. Six are cut from the same graphics translation unit the `value-home` and DMA
  // families above were cut from, whose body indexes a global array of 28-byte structs through a
  // variable index, a rank-2 table of pointers, and a rank-3 ROM table. The seventh, `arrcast`,
  // is NOT from that TU — it is a control constructed to guard a direction the other six leave
  // open (axis 2 below), and it is labelled as such rather than passed off as found code. asmlift recovers every one of those as a
  // CAST over the symbol's address — `((u16 *)&gTbl)[i]` — which scales the index FIRST and loads
  // the base second. FIVE of the six scored targets load the base first (`arrcast` is the one that
  // does not), and the family measures that ordering plus a second, independent axis: where a
  // constant term ends up, in the pool word's relocation addend or in a runtime `add`.
  //
  // THE ATTRIBUTION, CORRECTED — the first cut of this block named ONE cause and there are TWO.
  // agbcc's `c-typeck.c` does fork the subscript on
  // `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF`, so a bare
  // `gTbl[i]` over a declared array loads the base first. But so does an ordinary POINTER LOCAL
  // holding the base, which has no array type at all. Measured object-vs-object against these
  // rows' own targets, with `arm-none-eabi-objdump` confirming instruction-identical output:
  //
  //   extern u16 gTbl[]; u32 harr(u32 i){ u16 *p = (u16 *)&gTbl; return p[i]; }          -> 0
  //   struct Elem0 {...}; u32 bgarr(u32 i){ struct Elem0 *p = (struct Elem0 *)&gBgInfo;
  //                                         return p[i].field_16; }                      -> 0
  //   the same base-local shape against `harridx` (with or without the cast)              -> 6
  //   a RANK-PRESERVING base local against `tblrank2`
  //     `const s32 *(*p)[2] = (const s32 *(*)[2])&gPtrTbl; return (s32)p[i][j];`          -> 2
  //   a FLAT base local against `tblrank2` (base local AND the rank flattened)            -> 6
  //
  // So `harr` and `bgarr` DO NOT isolate the array-typed subscript: a base local reaches their
  // targets byte-for-byte, and that is the CHEAPER of two sufficient answers — a value home over a
  // named symbol, which is the family asmlift already has (`value-home` above, though every row
  // there spells its base as an address macro, never as a named symbol). A round that reads this
  // block should close `harr`/`bgarr` with the base local, and reach for the array fork only for
  // the other two.
  //
  // `harridx` and `tblrank2` are the rows where the base local is NOT sufficient, but they fail
  // it differently and the difference is the point. On `harridx` the base local is simply wrong
  // (6, against asmlift's 5 today) — the addend decides and no base spelling reaches it. On
  // `tblrank2` the base local is a PARTIAL: rank-preserving it scores 2, BETTER than the 3 asmlift
  // ranks today, so a base-local lever alone would move that row without matching it. Only the
  // array-typed subscript with the rank preserved reaches 0. Note also that the two `tblrank2`
  // figures differ by whether the RANK survives, not by the base spelling — flattening the rank
  // costs 4 points on its own, which is the same axis the additivity gate below measures.
  //
  // Today, agbcc only, map-less, fan 2 on every scored row, BOTH candidates of every fan scoring
  // identically, winning label `unsigned` on every scored row, one declaration synthesized on
  // each — each figure from
  // `pnpm bench run --tier synthetic --only <sym> --toolchain agbcc --serial`:
  //
  //   harr      2      width > 1, no constant term. Base local OR array subscript reaches it
  //   harridx   5      a constant term at width 1 — target pool word `.word gTbl` plus
  //                    `add r0,r0,#0x1`, asmlift `((u8 *)&gTbl)[a0 + 1]`, which agbcc folds
  //                    into a pool word of `.word gTbl+0x1` and no `add`. Base local scores 6
  //   bgarr     8      the struct-array member read. Base local OR array subscript reaches it
  //   tblrank2  3      the declared rank — AND the additivity gate, below. A rank-preserving
  //                    base local scores 2 here: better than today, still not a match
  //   arrbias   0      MATCH. OVER-FIRE CONTROL, addend direction — see below
  //   arrcast   0      MATCH. OVER-FIRE CONTROL, zero-addend direction — see below
  //   outparam  none   no score at all: a whole-function DECLINE
  //
  // THESE ARE THE FIRST SYNTHETIC ROWS THAT RELOCATE AGAINST A NAMED DATA GLOBAL, and that is
  // deliberate rather than convenient. The family was planned in the respelled address-macro form
  // every other synthetic global here uses (`#define gTbl ((u16 *)0x03003430)`), and respelled it
  // MEASURES NOTHING: all of them score 0 today. An array-typed OBJECT requires a SYMBOL, so at a
  // literal address every available C spelling is a pointer cast or an INDIRECT_REF and takes the
  // pointer path — bare `gTbl[i]`, `((u16 *)LIT)[i]` and `(*(u16 (*)[])LIT)[i]` compile to ONE
  // object (md5 61b257461c93f452d7ea79e0778da534 for all three). The addend goes the same way:
  // respelled, `harridx` and `arrbias` constant-fold to the same `.word 0x3003431` and become the
  // same row, which would destroy the control. The rows compile because asmlift synthesizes the
  // declaration itself off the target asm (`[declared] 1 declaration(s) synthesized`), `as` accepts
  // an undefined `R_ARM_ABS32` in a `.o`, and objdiff pairs relocations BY SYMBOL NAME. NOTE that
  // three family headers far above this block (`value-home`, `read-once`, and the fold family that
  // books the named-symbol question as unreachable) asserted a synthetic candidate could not
  // declare an extern global; these seven rows refute that, and all three are corrected in place.
  // One nearby claim is NOT refuted and is left standing: no symbol map attaches to a synthetic
  // row, so a folded `gaddr` pool literal still never forms here. asmlift's synthesized
  // `extern u32 gTbl;` is the DECLARE path, which is a different thing.
  //
  // THE SOUNDNESS RULE THE FAMILY ENCODES. There are TWO INDEPENDENT AXES here, and the first cut
  // of this block fused them into one sentence about "bare versus cast" that is not what either
  // axis turns on. Both are measured below; neither is a licence for the other.
  //
  // AXIS 1 — WHERE THE CONSTANT TERM GOES. The full 2×4 cross, every spelling of `gTbl[i+1]`
  // against both `+1` targets (`harridx`'s pool word is a bare `.word gTbl` plus a runtime
  // `adds r0,#1`; `arrbias`'s is `.word gTbl+0x1` with no add — `R_ARM_ABS32 gTbl`, in-place
  // addend `01 00 00 00` at 0x8, against `harridx`'s `00 00 00 00`):
  //
  //                                                        vs harridx   vs arrbias
  //     gTbl[i + 1]                     (array, on index)      0 MATCH      5
  //     const u8 *p = &gTbl[1]; p[i]    (array, in base)       5            0 MATCH
  //     ((u8 *)&gTbl)[i + 1]            (cast,  on index)      5            0 MATCH
  //     *(u8 *)(i + ((u32)&gTbl + 1))   (cast,  in base)       5            0 MATCH
  //
  // Read the columns, because they are NOT symmetric and that asymmetry is the whole rule.
  // Against `arrbias` THREE spellings tie at 0 — anything that folds the constant into the base
  // reaches a pool addend, cast or not — so `arrbias` does not discriminate cast from array at
  // all; it discriminates BASE-FOLDED from ON-INDEX. Against `harridx` exactly ONE spelling
  // works, and it is the only one that is BOTH array-typed AND index-side: agbcc constant-folds
  // `&gTbl + 1` into the pool word for every pointer/cast base, so keeping the `+1` on the index
  // is not enough — `((u8 *)&gTbl)[i + 1]` still scores 5. So:
  //
  //     A pool addend means the constant belongs in the BASE, and three spellings all reach it.
  //     A bare pool word plus a runtime add means the constant belongs on the INDEX, and there
  //     only the DECLARED-ARRAY subscript survives, because every cast base folds it away.
  //
  // AXIS 2 — INSTRUCTION ORDER, which is what decides when there is no constant term at all. At a
  // zero addend the assembly still forks: base-first (`harr`, `bgarr`, `tblrank2`, and `arrbias`
  // too) wants a declared array or a base local, index-first (`arrcast`) wants the cast. A zero
  // addend therefore does NOT license base-first — that was the first cut's error, and `arrcast`
  // is the row added to catch it.
  //
  // TWO ROWS GUARD THIS, one per axis, and BOTH are authored as matches:
  //  • `arrbias` — AXIS 1, the addend direction. Applying the index-side spelling unconditionally
  //    — `extern u8 gTbl[]; return gTbl[a0 + 1];`, which is exactly what wins `harridx` — scores 5
  //    here, i.e. it loses the match. The
  //    mirror is byte-level: asmlift's `harridx` candidate `((u8 *)&gTbl)[a0 + 1]` assembles to
  //    `.text` bytes IDENTICAL to `arrbias`'s target (`01 49 40 18 00 78 70 47 01 00 00 00`, one
  //    `R_ARM_ABS32 gTbl`), and the two 5s are mirror-image breakdowns — `delete: 2` one way,
  //    `insert: 2` the other. One symbol, two opposite right answers, separated only by the addend.
  //  • `arrcast` — AXIS 2, the zero-addend direction, and the reason it exists is that the first cut of
  //    this family had no row here at all. Its target is `((u16 *)gTbl)[i]`: `R_ARM_ABS32 gTbl` at
  //    an in-place addend of `00 00 00 00`, yet `lsl` before `ldr`. Both base-first spellings lose
  //    it — bare `gTbl[i]` scores 2 and the base local `const u16 *p = gTbl; p[i]` scores 2 (they
  //    are the same object). A rule implemented as "addend zero, therefore base-first" over-fires
  //    on exactly this shape, and before this row nothing in the dataset caught it.
  //
  // HOW BOTH CONTROLS ACTUALLY BIND, because their fans make the obvious reading wrong. `rankBy`
  // sorts and returns `results[0]` (`packages/core/src/rank.ts`), so the published score is the
  // MINIMUM over the fan. `arrbias`'s fan is 2 and BOTH candidates score 0; `arrcast`'s likewise.
  // A lever that merely ADDS a base-first candidate therefore CANNOT move either row — the
  // 0-scoring cast candidate still wins, and the control reports green while the lever over-fires.
  // BOTH CONTROLS BIND ONLY ON A LEVER THAT REPLACES OR WITHHOLDS THE CURRENT WINNER. A lever
  // shipped additively must be checked by enumerating the fan (every candidate's score), not by
  // reading the row's published score.
  //
  // THE ADDITIVITY GATE — `tblrank2`, and this half is a PREDICTION, not a measurement of a
  // shipped lever. Endpoint-scored object-vs-object, half A alone (the array-typed subscript with
  // a flat index, in asmlift's own operand order) `extern s32 gPtrTbl[]; return gPtrTbl[j + i*2];`
  // scores 4 — WORSE than the 3 asmlift ranks today; the other operand order `gPtrTbl[i*2 + j]`
  // scores 6; both halves together, which is the row's own spelling, score 0. So the subscript and
  // the declared rank must ship TOGETHER or this row pays for the half. FALSIFYING COMMAND, and it
  // is an ENDPOINT check for the same reason the controls are: ship half A alone, then score the
  // half-A candidate against `tblrank2`'s target directly. Anything other than a score strictly
  // worse than 3 falsifies the claim. Do NOT read this off `pnpm bench run` — `tblrank2`'s fan is
  // 2 and both candidates score 3, so an additively-shipped half A leaves the published 3 standing
  // and the gate would report a falsification for a lever behaving exactly as predicted.
  //
  // TWO THINGS THE ROWS FALSIFIED, said here because it is easy to assume otherwise:
  //  • `bgarr` needs NO new element-layout capability. asmlift ALREADY synthesizes a correct
  //    28-byte element and the right member — `struct Elem0 { u8 _pad0[16]; u16 field_16;
  //    u8 _pad1[10]; }` reached as `((struct Elem0 *)&gBgInfo)[a0].field_16`. Feeding asmlift's
  //    OWN `Elem0` back through a DECLARED array (`extern struct Elem0 gBgInfo[];
  //    return gBgInfo[a0].field_16;`) scores 0, and through a BASE LOCAL scores 0 as well. The
  //    whole 8 is where the base is materialized, not what the element looks like; a round that
  //    closes it by inventing element layouts is aiming at the wrong gap.
  //  • `tblrank2`'s rank ARITHMETIC is already recovered. asmlift emits
  //    `*(s32 *)((a1 << 2) + (a0 << 3) + (u32)&gPtrTbl)` — the rank-preserving scaling, not the
  //    flat `(i * 2 + j) * 4`. The flat index is a symbol-side SPELLING, not an arithmetic gap.
  //
  // `outparam` IS A DIFFERENT KIND OF ROW: it has no score, and its gate is that it keeps
  // declining with the SAME first blocker after every rebase. It pins the out-parameter idiom
  // `T v; callee(&v); use(v);`. On the TARGET side, agbcc's `expand_decl` refuses a register to a
  // local whose address is taken, so the local becomes a one-word frame and its address becomes
  // argument 0. That explains the ASM but it is NOT what asmlift refuses on, and the first cut of
  // this block wrongly implied it was: the perturbation `s32 v = 0; fill(&v); return v;` is
  // equally address-taken and lifts CLEANLY to `s32 sp0; sp0 = 0; fill(&sp0); return sp0;`. The
  // discriminator is the STORE-LESS slot — the frame word is never written before the call — which
  // is what the message itself says. ATTRIBUTION, re-triggered rather than quoted, first blocker
  // `packages/core/src/frontend/thumb.ts:3395`, message verbatim:
  //     cannot lift 'outparam': address-taken stack local — the one-word frame is handed to a
  //     callee as argument 0 and never written here, which is how a hidden struct-return pointer
  //     looks — the callee owning the storage is not provably an addressable local
  // That is a whole-function decline: zero candidates, no `[ranked]` line, nothing to score. Its
  // `proto` entry is INERT TODAY — the decline is byte-identical with and without it — so the gate
  // is the decline message alone and cannot detect a proto regression. The entry is kept because
  // it becomes live the moment the decline is closed.
  //
  // THE m2c SIDE, and the first cut of this block stated its cost BACKWARDS. All six scored rows
  // are `declined` for m2c on its OWN self-reported gap — it emits `extern ? gTbl;` and the
  // `? placeholder` is what the classifier reads. `outparam` is `noncompile` for m2c: it emits
  // `fill(&unksp0);` with no declaration of `unksp0`, the same pre-existing class already carried
  // by `stkaddr`, `maskhome` and `dmastride`. What that block called "five one-sided noncompiles
  // bought on a declaration-emission convention" is not what withholding the declaration costs.
  // MEASURED — m2c run with `--context` naming the array, its output scored with that same context
  // prepended:
  //
  //   harr      `return (u32) gTbl[i];`                          score 0, MATCH
  //   arrbias   `return (u32) (gTbl + 1)[i];`                    score 0, MATCH
  //   arrcast   `return (u32) gTbl[i];`                          score 2
  //   tblrank2  `return *((j * 4) + (i * 8) + gPtrTbl);`         score 10
  //   harridx   `return (u32) gTbl[i].unk1;`                     noncompile
  //   bgarr     `return (u32) ((i * 0x1C) + gBgInfo)->unk10;`    noncompile
  //
  // So the withheld declaration costs m2c TWO BYTE-EXACT MATCHES, not five noncompiles. Note that
  // it is not uniformly a gift either: on `arrcast` m2c emits the same base-first `gTbl[i]` it
  // emits for `harr`, which is the WRONG spelling for that target, so the declaration would move
  // it to 2 rather than to a match — m2c has no more of the axis-2 distinction than asmlift does.
  // This is a
  // ONE-SIDED HANDICAP ON EXACTLY THESE ROWS and it should be read that way: asmlift does not need
  // the `ctx` because it synthesizes the declaration off the target asm itself, and m2c cannot.
  // The rows are published anyway, with the cost stated, because the alternative is worse — the
  // SYNTHETIC tier does not prepend `ctx` to m2c's candidate at scoring time the way the real tier
  // does (`makeRealScorer` in `apps/benchmark/src/cases/real.ts` vs `scoreM2c` in
  // `apps/benchmark/src/eval/evaluate.ts`), so putting the array in `ctx` here yields a noncompile
  // on every scored row and measures even less. Prototypes-only is this dataset's stated rule (see the
  // file header) and is what ships; the m2c column on these seven rows is NOT a fair read of m2c's
  // array-shape ability, and fixing the tier is a harness change that belongs to a harness round.
  //
  // agbcc only. The nearest precedent is `read-once`, which is genuinely agbcc-only; `uninit-local`
  // and `value-home` are NOT — they span all four toolchains (7 and 52 rows over agbcc, ido7.1,
  // gcc2.7.2kmc and mwcc_242_81), so no appeal to them justifies anything here. The reason these
  // stay agbcc-only is direct: whether ido7.1, gcc2.7.2kmc and mwcc_242_81 fork the subscript on
  // the operand's array-ness at all was NOT measured, so those lanes are left off rather than
  // assumed; what would earn one is the same compiled pair on that toolchain showing the same
  // divergence.
  {
    sym: 'harr',
    src: 'extern u16 gTbl[];\nu32 harr(u32 i){ return gTbl[i]; }',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u32 harr(u32 i);',
  },
  {
    sym: 'harridx',
    src: 'extern u8 gTbl[];\nu32 harridx(u32 i){ return gTbl[i+1]; }',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u32 harridx(u32 i);',
  },
  {
    sym: 'bgarr',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      'extern struct BgInfo gBgInfo[4];\n' +
      'u32 bgarr(u32 i){ return gBgInfo[i].hLength; }',
    features: ['global', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ['agbcc'],
    ctx: 'u32 bgarr(u32 i);',
  },
  {
    sym: 'tblrank2',
    src: 'extern const s32 *gPtrTbl[][2];\ns32 tblrank2(u32 i, u32 j){ return (s32)gPtrTbl[i][j]; }',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 's32 tblrank2(u32 i, u32 j);',
  },
  {
    sym: 'arrbias',
    src: 'extern u8 gTbl[];\nu32 arrbias(u32 i){ const u8 *p = &gTbl[1]; return p[i]; }',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'u32 arrbias(u32 i);',
  },
  {
    sym: 'arrcast',
    src: 'extern u16 gTbl[];\nu32 arrcast(u32 i){ return ((u16 *)gTbl)[i]; }',
    // NO `variable-index` tag, though the index IS variable: that tag's floor is
    // `/\w+\s*\[\s*[^\]\d\s]/`, an identifier immediately before the `[`, and this row's
    // subscript sits on a parenthesized cast (`)[i]`) so the floor rejects it. Widening a shared
    // floor for one row is the wrong trade; the tag is dropped and the omission recorded here.
    features: ['global', 'array', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'u32 arrcast(u32 i);',
  },
  {
    sym: 'outparam',
    src: 'extern void fill(s32 *p);\ns32 outparam(void){ s32 v; fill(&v); return v; }',
    features: ['stack-addr', 'uninit-local'],
    toolchains: ['agbcc'],
    ctx: 'void fill(s32 *p); s32 outparam(void);',
    proto: { fill: { params: 1, returnsVoid: true } },
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
