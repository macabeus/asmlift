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
  { sym: 'mulc', src: 'int mulc(int a){ return a*10; }', features: ['arithmetic', 'strength-reduce'], toolchains: ALL },
  { sym: 'divc', src: 'int divc(int a){ return a/7; }', features: ['arithmetic', 'signed-div-const'], toolchains: ALL },
  { sym: 'div2', src: 'int div2(int a){ return a/2; }', features: ['arithmetic', 'signed-div-pow2'], toolchains: ALL },
  {
    sym: 'udivc',
    src: 'unsigned udivc(unsigned a){ return a/7; }',
    features: ['arithmetic', 'unsigned-div-const'],
    toolchains: ALL,
  },
  {
    sym: 'modc',
    src: 'int modc(int a){ return a%10; }',
    features: ['arithmetic', 'signed-mod-const'],
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
    features: ['arithmetic', 'expr'],
    toolchains: ALL,
  },

  // ── bitwise ───────────────────────────────────────────────────────────────────────────
  { sym: 'band', src: 'int band(int a,int b){ return a&b; }', features: ['bitwise'], toolchains: ALL },
  { sym: 'bor', src: 'int bor(int a,int b){ return a|b; }', features: ['bitwise'], toolchains: ALL },
  { sym: 'bxor', src: 'int bxor(int a,int b){ return a^b; }', features: ['bitwise'], toolchains: ALL },
  { sym: 'bnot', src: 'int bnot(int a){ return ~a; }', features: ['bitwise'], toolchains: ALL },
  { sym: 'shl', src: 'int shl(int a,int b){ return a<<b; }', features: ['bitwise', 'shift'], toolchains: ALL },
  {
    sym: 'shru',
    src: 'unsigned shru(unsigned a,int b){ return a>>b; }',
    features: ['bitwise', 'shift'],
    toolchains: ALL,
  },
  {
    sym: 'shrs',
    src: 'int shrs(int a,int b){ return a>>b; }',
    features: ['bitwise', 'shift', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'mask8',
    src: 'unsigned mask8(unsigned x){ return x & 0xff; }',
    features: ['bitwise', 'mask'],
    toolchains: ALL,
  },
  {
    sym: 'bittest',
    src: 'int bittest(int x,int n){ return (x>>n)&1; }',
    features: ['bitwise', 'shift', 'mask'],
    toolchains: ALL,
  },
  {
    sym: 'setbit',
    src: 'int setbit(int x,int n){ return x | (1<<n); }',
    features: ['bitwise', 'shift'],
    toolchains: ALL,
  },

  // ── comparison / logic ──────────────────────────────────────────────────────────────────
  { sym: 'maxi', src: 'int maxi(int a,int b){ return a>b?a:b; }', features: ['compare', 'ternary'], toolchains: ALL },
  { sym: 'mini', src: 'int mini(int a,int b){ return a<b?a:b; }', features: ['compare', 'ternary'], toolchains: ALL },
  {
    sym: 'clamp0',
    src: 'int clamp0(int x){ if(x<0) return 0; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'absi', src: 'int absi(int x){ return x<0?-x:x; }', features: ['compare', 'ternary'], toolchains: ALL },
  {
    sym: 'sign',
    src: 'int sign(int x){ if(x>0)return 1; if(x<0)return -1; return 0; }',
    features: ['compare', 'branch', 'multi-if'],
    toolchains: ALL,
  },
  { sym: 'iszero', src: 'int iszero(int x){ return x==0; }', features: ['compare', 'bool'], toolchains: ALL },
  {
    sym: 'land',
    src: 'int land(int a,int b){ return a && b; }',
    features: ['compare', 'logical-and'],
    toolchains: ALL,
  },
  { sym: 'lor', src: 'int lor(int a,int b){ return a || b; }', features: ['compare', 'logical-or'], toolchains: ALL },
  {
    sym: 'inrange',
    src: 'int inrange(int x,int lo,int hi){ return x>=lo && x<=hi; }',
    features: ['compare', 'logical-and', 'range'],
    toolchains: ALL,
  },
  {
    sym: 'clampr',
    src: 'int clampr(int x,int lo,int hi){ if(x<lo)x=lo; if(x>hi)x=hi; return x; }',
    features: ['compare', 'branch', 'multi-if'],
    toolchains: ALL,
  },

  // ── width / casts ───────────────────────────────────────────────────────────────────────
  { sym: 'tou8', src: 'u8 tou8(int x){ return (u8)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'tos8', src: 's8 tos8(int x){ return (s8)x; }', features: ['cast', 'narrow', 'signed'], toolchains: ALL },
  { sym: 'tou16', src: 'u16 tou16(int x){ return (u16)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'sextb', src: 'int sextb(s8 x){ return x; }', features: ['cast', 'sign-extend'], toolchains: ALL },
  { sym: 'zextb', src: 'int zextb(u8 x){ return x; }', features: ['cast', 'zero-extend'], toolchains: ALL },

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
    features: ['memory', 'load', 'offset'],
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
    features: ['memory', 'array', 'byte'],
    toolchains: ALL,
  },
  {
    sym: 'ptradd',
    src: 'int *ptradd(int *p,int n){ return p+n; }',
    features: ['memory', 'pointer-arith'],
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

  // ── loops ──────────────────────────────────────────────────────────────────────────────
  {
    sym: 'sumto',
    src: 'int sumto(int n){ int s=0,i; for(i=0;i<n;i++)s+=i; return s; }',
    features: ['loop', 'for'],
    toolchains: ALL,
  },
  {
    sym: 'countdown',
    src: 'int countdown(int n){ int c=0; while(n>0){c++;n--;} return c; }',
    features: ['loop', 'while'],
    toolchains: ALL,
  },
  {
    sym: 'arraysum',
    src: 'int arraysum(int *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]; return s; }',
    features: ['loop', 'for', 'memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'strlen1',
    src: 'int strlen1(char *s){ int n=0; while(*s){n++;s++;} return n; }',
    features: ['loop', 'while', 'memory', 'pointer'],
    toolchains: ALL,
  },
  {
    sym: 'memset1',
    src: 'void memset1(u8 *p,int n,u8 v){ int i; for(i=0;i<n;i++)p[i]=v; }',
    features: ['loop', 'for', 'memory', 'store'],
    toolchains: ALL,
    ctx: 'void memset1(u8*,int,u8);',
    proto: { memset1: { returnsVoid: true } },
  },
  {
    sym: 'findfirst',
    src: 'int findfirst(int *a,int n,int t){ int i; for(i=0;i<n;i++) if(a[i]==t) return i; return -1; }',
    features: ['loop', 'for', 'branch', 'memory'],
    toolchains: ALL,
  },

  // ── calls ───────────────────────────────────────────────────────────────────────────────
  {
    sym: 'call1',
    src: 'int helper(int);\nint call1(int x){ return helper(x)+1; }',
    features: ['call'],
    toolchains: CALL,
    ctx: 'int helper(int);',
    proto: { helper: { params: 1 } },
  },
  {
    sym: 'call2',
    src: 'int add3(int,int,int);\nint call2(int a,int b){ return add3(a,b,a+b); }',
    features: ['call', 'multi-arg'],
    toolchains: CALL,
    ctx: 'int add3(int,int,int);',
    proto: { add3: { params: 3 } },
  },
  {
    sym: 'voidcall',
    src: 'void sink(int);\nvoid voidcall(int x){ sink(x); }',
    features: ['call', 'void'],
    toolchains: CALL,
    ctx: 'void sink(int); void voidcall(int);',
    proto: { sink: { params: 1, returnsVoid: true }, voidcall: { returnsVoid: true } },
  },

  // ── nested control flow ─────────────────────────────────────────────────────────────────
  {
    sym: 'nestedif',
    src: 'int nestedif(int a,int b){ if(a>0){ if(b>0) return a+b; return a; } return 0; }',
    features: ['branch', 'nested-if'],
    toolchains: ALL,
  },
  {
    sym: 'loopif',
    src: 'int loopif(int *a,int n){ int s=0,i; for(i=0;i<n;i++){ if(a[i]>0) s+=a[i]; } return s; }',
    features: ['loop', 'branch', 'memory'],
    toolchains: ALL,
  },

  // ── switch (comparison-tree, sparse, fallthrough, default, and a DENSE jump table) ───────────
  // The small (2–5-case) switches below compile to comparison trees on every toolchain; only a
  // dense contiguous switch (sw_jt) becomes a real jump table. Both regimes are exercised.
  {
    sym: 'sw_ret',
    src: 'int sw_ret(int x){ switch(x){case 0:return 10;case 1:return 20;case 2:return 30;case 3:return 40;default:return -1;} }',
    features: ['switch', 'comparison-tree'],
    toolchains: ALL,
  },
  {
    sym: 'sw_op',
    src: 'int sw_op(int op,int a,int b){ switch(op){case 0:return a+b;case 1:return a-b;case 2:return a*b;case 3:return a&b;default:return 0;} }',
    features: ['switch', 'comparison-tree', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'sw_fall',
    src: 'int sw_fall(int x){ int r=0; switch(x){case 3:r++;case 2:r++;case 1:r++;} return r; }',
    features: ['switch', 'fallthrough'],
    toolchains: ALL,
  },
  {
    sym: 'sw_sparse',
    src: 'int sw_sparse(int x){ switch(x){case 1:return 1;case 10:return 2;case 100:return 3;case 1000:return 4;default:return 0;} }',
    features: ['switch', 'sparse'],
    toolchains: ALL,
  },
  {
    sym: 'sw_void',
    src: 'void sw_void(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;default:*p=0;} }',
    features: ['switch', 'void', 'memory'],
    toolchains: ALL,
    ctx: 'void sw_void(int,int*);',
    proto: { sw_void: { returnsVoid: true } },
  },
  // Dense 8-case switch → a jump table on every toolchain (agbcc `mov pc` inline table; IDO/KMC
  // `jr` + `.rodata`; mwcc `bctr` + `.data`); MIPS/PPC recovery needs the AsmData side-table.
  {
    sym: 'sw_jt',
    src: 'int sw_jt(int x){ switch(x){case 0:return 3;case 1:return 5;case 2:return 7;case 3:return 9;case 4:return 11;case 5:return 13;case 6:return 15;case 7:return 17;default:return -1;} }',
    features: ['switch', 'jump-table', 'dense'],
    toolchains: ALL,
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
    features: ['float', 'arithmetic', 'expr'],
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
    features: ['s64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llsub',
    src: 'long long llsub(long long a,long long b){ return a-b; }',
    features: ['s64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llshl',
    src: 'long long llshl(long long a,int b){ return a<<b; }',
    features: ['s64', 'shift'],
    toolchains: ALL,
  },
  {
    sym: 'llshr',
    src: 'long long llshr(long long a,int b){ return a>>b; }',
    features: ['s64', 'shift', 'signed'],
    toolchains: ALL,
  },
  { sym: 'i2ll', src: 'long long i2ll(int x){ return x; }', features: ['s64', 'cast', 'sign-extend'], toolchains: ALL },
  { sym: 'll2i', src: 'int ll2i(long long x){ return (int)x; }', features: ['s64', 'cast', 'narrow'], toolchains: ALL },
  {
    sym: 'llcmp',
    src: 'int llcmp(long long a,long long b){ return a<b; }',
    features: ['s64', 'compare'],
    toolchains: ALL,
  },

  // ── division / modulo by constant (magic-number division) ───────────────────────────────────
  {
    sym: 'divc10',
    src: 'int divc10(int a){ return a/10; }',
    features: ['arithmetic', 'signed-div-const', 'magic-div'],
    toolchains: ALL,
  },
  {
    sym: 'divc100',
    src: 'int divc100(int a){ return a/100; }',
    features: ['arithmetic', 'signed-div-const', 'magic-div'],
    toolchains: ALL,
  },
  {
    sym: 'udivc10',
    src: 'unsigned udivc10(unsigned a){ return a/10; }',
    features: ['arithmetic', 'unsigned-div-const', 'magic-div'],
    toolchains: ALL,
  },
  {
    sym: 'umod10',
    src: 'unsigned umod10(unsigned a){ return a%10; }',
    features: ['arithmetic', 'unsigned-mod-const', 'magic-div'],
    toolchains: ALL,
  },
  {
    sym: 'modpow2',
    src: 'int modpow2(int a){ return a%16; }',
    features: ['arithmetic', 'signed-mod-pow2'],
    toolchains: ALL,
  },
  {
    sym: 'avg2',
    src: 'int avg2(int a,int b){ return (a+b)/2; }',
    features: ['arithmetic', 'signed-div-pow2'],
    toolchains: ALL,
  },

  // ── bit manipulation ────────────────────────────────────────────────────────────────────────
  {
    sym: 'rotl',
    src: 'unsigned rotl(unsigned x,int n){ return (x<<n)|(x>>(32-n)); }',
    features: ['bitwise', 'rotate', 'shift'],
    toolchains: ALL,
  },
  {
    sym: 'rotr',
    src: 'unsigned rotr(unsigned x,int n){ return (x>>n)|(x<<(32-n)); }',
    features: ['bitwise', 'rotate', 'shift'],
    toolchains: ALL,
    ctx: 'unsigned rotr(unsigned,int);',
  },
  {
    sym: 'extractbits',
    src: 'unsigned extractbits(unsigned x){ return (x>>4)&0xF; }',
    features: ['bitwise', 'shift', 'mask'],
    toolchains: ALL,
  },
  {
    sym: 'clearbit',
    src: 'int clearbit(int x,int n){ return x & ~(1<<n); }',
    features: ['bitwise', 'shift'],
    toolchains: ALL,
  },
  {
    sym: 'togglebit',
    src: 'int togglebit(int x,int n){ return x ^ (1<<n); }',
    features: ['bitwise', 'shift'],
    toolchains: ALL,
  },
  { sym: 'hi16', src: 'unsigned hi16(unsigned x){ return x>>16; }', features: ['bitwise', 'shift'], toolchains: ALL },
  {
    sym: 'mergebits',
    src: 'unsigned mergebits(unsigned a,unsigned b){ return (a&0xFFFF)|(b<<16); }',
    features: ['bitwise', 'mask', 'shift'],
    toolchains: ALL,
  },
  {
    sym: 'signum',
    src: 'int signum(int x){ return (x>0)-(x<0); }',
    features: ['compare', 'branchless'],
    toolchains: ALL,
  },

  // ── compare / branchless / select ───────────────────────────────────────────────────────────
  {
    sym: 'absdiff',
    src: 'int absdiff(int a,int b){ return a>b?a-b:b-a; }',
    features: ['compare', 'ternary'],
    toolchains: ALL,
  },
  {
    sym: 'clampu8',
    src: 'int clampu8(int x){ if(x<0)return 0; if(x>255)return 255; return x; }',
    features: ['compare', 'branch', 'multi-if'],
    toolchains: ALL,
  },
  {
    sym: 'max3',
    src: 'int max3(int a,int b,int c){ int m=a>b?a:b; return m>c?m:c; }',
    features: ['compare', 'ternary'],
    toolchains: ALL,
  },
  {
    sym: 'selnz',
    src: 'int selnz(int c,int a,int b){ return c?a:b; }',
    features: ['compare', 'ternary', 'select'],
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
    features: ['loop', 'memory', 'store', 'load'],
    toolchains: ALL,
    ctx: 'void memcpy1(u8*,u8*,int);',
    proto: { memcpy1: { returnsVoid: true } },
  },
  {
    sym: 'revarr',
    src: 'void revarr(int *a,int n){ int i,j,t; for(i=0,j=n-1;i<j;i++,j--){t=a[i];a[i]=a[j];a[j]=t;} }',
    features: ['loop', 'memory', 'store'],
    toolchains: ALL,
    ctx: 'void revarr(int*,int);',
    proto: { revarr: { returnsVoid: true } },
  },
  {
    sym: 'maxarr',
    src: 'int maxarr(int *a,int n){ int m=a[0],i; for(i=1;i<n;i++)if(a[i]>m)m=a[i]; return m; }',
    features: ['loop', 'memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'countpos',
    src: 'int countpos(int *a,int n){ int c=0,i; for(i=0;i<n;i++)if(a[i]>0)c++; return c; }',
    features: ['loop', 'memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'dotprod',
    src: 'int dotprod(int *a,int *b,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]*b[i]; return s; }',
    features: ['loop', 'memory', 'arithmetic'],
    toolchains: ALL,
    ctx: 'int dotprod(int*,int*,int);',
  },
  {
    sym: 'structarr',
    src: 'struct P{int x;int y;};\nint structarr(struct P *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i].x; return s; }',
    features: ['loop', 'struct', 'memory', 'array'],
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
    features: ['loop', 'memory', 'pointer', 'compare'],
    toolchains: ALL,
  },

  // ── loops (do-while, nested, break/continue, accumulators) ──────────────────────────────────
  {
    sym: 'gcd',
    src: 'int gcd(int a,int b){ while(b){int t=b;b=a%b;a=t;} return a; }',
    features: ['loop', 'while', 'mod-reg'],
    toolchains: ALL,
  },
  {
    sym: 'fib',
    src: 'int fib(int n){ int a=0,b=1,i; for(i=0;i<n;i++){int t=a+b;a=b;b=t;} return a; }',
    features: ['loop', 'for'],
    toolchains: ALL,
  },
  {
    sym: 'powi',
    src: 'int powi(int base,int e){ int r=1,i; for(i=0;i<e;i++)r*=base; return r; }',
    features: ['loop', 'for', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'nestedloop',
    src: 'int nestedloop(int n){ int s=0,i,j; for(i=0;i<n;i++)for(j=0;j<n;j++)s+=i*j; return s; }',
    features: ['loop', 'nested-loop', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'dowhile',
    src: 'int dowhile(int n){ int s=0; do{s+=n;n--;}while(n>0); return s; }',
    features: ['loop', 'do-while'],
    toolchains: ALL,
  },
  {
    sym: 'breakloop',
    src: 'int breakloop(int *a,int n){ int i; for(i=0;i<n;i++)if(a[i]<0)break; return i; }',
    features: ['loop', 'for', 'break', 'memory'],
    toolchains: ALL,
  },
  {
    sym: 'continueloop',
    src: 'int continueloop(int *a,int n){ int s=0,i; for(i=0;i<n;i++){if(a[i]<0)continue;s+=a[i];} return s; }',
    features: ['loop', 'for', 'continue', 'memory'],
    toolchains: ALL,
  },

  // ── casts / integer promotion ───────────────────────────────────────────────────────────────
  {
    sym: 'addu8',
    src: 'u8 addu8(u8 a,u8 b){ return a+b; }',
    features: ['cast', 'narrow', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'promsh',
    src: 'int promsh(s16 a,s16 b){ return a+b; }',
    features: ['cast', 'promotion', 'arithmetic'],
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
    features: ['cast', 'narrow', 'arithmetic'],
    toolchains: ALL,
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
    features: ['c++', 'method', 'this-ptr'],
    toolchains: ['mwcc_242_81'],
    note: 'C++ method via this-pointer',
  },
  {
    sym: 'Counter__inc',
    lang: 'c++',
    src: 'struct Counter{int n;void inc(){ n++; }};\nextern "C" void Counter__inc(Counter*c){ c->inc(); }',
    features: ['c++', 'method', 'mutate'],
    toolchains: ['mwcc_242_81'],
    // `struct` spelled out: the ctx must parse as C (m2c's context parser) AND as C++
    ctx: 'struct Counter; void Counter__inc(struct Counter*);',
    proto: { Counter__inc: { returnsVoid: true } },
  },
];
