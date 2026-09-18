// A NARROW DECLARED PARAMETER, extended once in the prologue.
//
// agbcc has no byte/half register move, so a callee whose parameter is declared `u8`/`s16` widens
// it itself, with a shift pair at the very top of the function — the caller passes a full register
// and the extension is part of the prologue. Both spellings below compiled with this benchmark's
// own agbcc, and where each one puts the pair is the whole rule:
//
//     void pa(s32 *out, u8 a)  { out[0]=1; out[1]=2; out[2]=a; }      lsl/lsr mov str mov str str
//     void pb(s32 *out, s32 a) { out[0]=1; out[1]=2; out[2]=(u8)a; }  mov str mov str lsl/lsr str
//
// The idiom patterns fold that pair to one `zext`/`sext` op, so `pa`'s parameter reaches this pass
// as a value whose SOLE use is its own extension — nothing can read the raw register, which is
// exactly what a narrow declaration means. Recovered as a wide parameter instead, the same function
// has to re-spell `(u8)a` at every use; agbcc then elides an extension no use needs, gives the
// extended value no register of its own, and the whole allocation moves.
//
// WIDTH AND SIGNEDNESS ARE READ OFF, NOT GUESSED: the extension states both (agbcc's shift pair by
// its amount and its `asr`/`lsr`, PPC's by the opcode), so no width is ever enumerated here.
//
// NOT agbcc-GATED, because the shape is not agbcc's alone: mwcc's PPC prologue widens a declared
// narrow parameter with the `extsb`/`extsh` the frontend lifts to the same op, and the synthetic
// `sextb`/`tos8` rows keep matching on that toolchain through this pass.
//
// BUT THE PROLOGUE TEST IS NOT UNIVERSAL EVIDENCE, AND ON MIPS IT IS NO EVIDENCE AT ALL. Everything
// above reads the extension's POSITION, which works only where the compiler puts a declaration's
// extension somewhere a body cast's never goes. IDO 7.1 at -O2 does not: it leads the function with
// the `sll` for BOTH spellings. Two OTHER facts separate them there, and it takes both — each one
// alone is refuted by a compiled counterexample, at the row's own flags:
//
//                                             home store   widened in place
//   int f(s8 x){ return x; }                      sw a0     sll a0,a0,0x18     the declaration
//   int f(s32 x){ return (s8)x; }                   —       sll v0,a0,0x18     a body cast
//   int f(int x){ x = (signed char)x; return x; }   —       sll a0,a0,0x18     NOT homed
//   int f(long long x){ return (signed char)x; }  sw a1     sll v0,a1,0x18     NOT in place
//
// The last two lines are why the conjunction is the claim. A DEAD ABI ARGUMENT HOME STORE on its
// own is not "declared narrow" — IDO emits one wherever the incoming register value goes unused,
// whatever that value's type:
//
//   int unused1(int x){ return 7; }         sw a0,0(sp) / jr ra / li v0,7
//   int ptr1(int *p, int y){ return y; }    sw a0,0(sp) / jr ra / move v0,a1
//   int ll2i(long long x){ return (int)x; } sw a0,0(sp) / sw a1,4(sp) / jr ra / move v0,a1
//   int used2(int x, int y){ return x+y; }  jr ra / addu v0,a0,a1        (no store at all)
//
// — so the store says the incoming register was not consumed, not that anything was declared
// narrow, and on the `long long` line that is a 64-bit parameter whose low half the extension would
// narrow to `s8`; `widened-elsewhere` is what refuses it. WIDENING IN PLACE on its own is not
// "declared narrow" either: the third line is a plain `int` the source re-assigns, and only the
// absent home store tells it from the first.
//
// The conjunction is NECESSARY-and-measured, not necessary-and-sufficient, and it errs toward
// refusing: `int m2(signed char a){ int i,s=0; for(i=0;i<10;i++) s+=arr[i]+a; return s; }` is a
// narrow declaration IDO widens into a SCRATCH register under register pressure (`sll a1,a0,0x18`),
// so this pass leaves its parameter wide and re-spells the cast. That is a worse-reading answer,
// not a wrong one.
//
// THE PAIR SAYS A NARROW DECLARATION EXISTS, NOT WHICH ONE. The WIDTH comes from the extension,
// and where a wider mask sits on that extension's result the declaration could have been the wider
// type — `int f(u16 x){ x = (signed char)x; return x; }` and `int f(s8 x){ return x & 0xffff; }`
// are ONE object at the row's own flags (`sw a0,0(sp) / sll a0,a0,0x18 / sra a0,a0,0x18 / andi
// v0,a0,0xffff`), so the asm decides nothing between them and this pass answers `s8`. Refusing on
// that disagreement is not the repair, because the spelling a refusal falls back to is a DIFFERENT
// object: `int f(int a){ return ((a << 24) >> 24) & 0xffff; }` is four words with no home store and
// both shifts in `v0`, so the refusal would cost the byte match under BOTH readings. Where the
// caller declares the parameter `proto-width` takes the tiebreak; where nobody does, the two
// readings recompile alike and only a PROTOTYPED CALL SITE of this function could tell them apart.
//
// Ungated, this pass narrows the body cast too and loses `synthetic:tos8:ido7.1`, a MATCH. The two
// MIPS GCCs are a third case again: their two spellings are one BYTE-IDENTICAL object, so nothing
// in the asm decides the width and the honest answer is to leave the extension standing.
//
// So which fact settles the width is a per-COMPILER question, asked as
// `compilerBehaviors.narrowParamWitness` and answered by `no-declaration-witness`, `unhomed-param`
// and `widened-elsewhere` below. Both facts it reads are destroyed at lift and survive as the
// frontend's `Fn.paramEvidence` (ir/core.ts).
//
// `not-prologue` STILL FIRES ON SUCH A TARGET, and it costs rather than protects there. IDO's
// scheduler interleaves the widenings of several narrow parameters with the arithmetic that
// consumes the earlier ones, and the scan below stops at the first value-reading op, so only the
// LEADING parameters are seen as prologue:
//
//     int d4(s8 a, s8 b, s8 c){ return a+b+c; }   sll a1 / sll a0 / sll a2 / sra a0 / sra a1 /
//                                                 addu t6,a0,a1 / sra a2 / addu v0,t6,a2
//       recovered  s32 d4(s8 a0, s8 a1, s32 a2) { return a0 + a1 + (s8)a2; }
//     int m3(s16 a, s16 b, s16 c, s16 d){ return a*b+c*d; }  all four widenings precede the first
//       recovered  s32 m3(s16 a0, s16 a1, s16 a2, s16 a3)    multiply — all four narrow
//
// So the limit is the SCHEDULE's, not the declaration's, and the gate answers in the refusing
// direction on the parameters it cuts off. Kept because it is the sound direction and because it is
// the only gate that keeps a body cast behind real body code from being read as a prologue widening
// on the position-witness targets; NO row on either tier is known to turn on the IDO half of it —
// `d4` above is a probe, not a row, and lifting the scan is a change with its own measurement to make.
//
// WHAT THE PROLOGUE TEST CANNOT SEE, and why the declaration settles it. The scan steps over the
// pure materializations agbcc interleaves among the extensions, so a constant the scheduler HOISTED
// above a mid-body cast leaves `pb` looking like `pa`:
//
//     void pc(s32 a, s32 *out) { s32 t = 7; out[0] = (u8)a; out[1] = t; out[2] = t; }
//         movs r2,#7 / lsls r0,#24 / lsrs r0,#24 / str / str / str
//     void pc(u8 a, s32 *out)  { s32 t = 7; out[0] = a;     out[1] = t; out[2] = t; }
//         lsls r0,#24 / lsrs r0,#24 / movs r2,#7 / str / str / str
//
// Those two ROM sources are DIFFERENT BYTES — the const moves across the shift pair — so the width
// is a fact here and not a spelling, while no reader of the raw register and no body code is
// present to make the gates below refuse. Nor does the ORDER decide it: sa3's `sub_802DFC8` really
// is declared `s16 direction` and agbcc emits its `movs r5, #0` before the `lsl/asr` too, so the
// hoisted-const shape arrives from both source spellings and reaches this pass as the same IR.
//
// The tiebreak is therefore not in the asm, and the SCORE cannot supply it either: asmlift
// re-materializes a small constant at each use instead of binding it to a local, so its own two
// spellings of `pc` emit the same instruction order and score alike. `proto-width` takes the
// tiebreak from the caller's declaration instead, and where none was supplied the extension stands.
// What that refusal protects is a function this pass never compiles: agbcc truncates at every
// PROTOTYPED CALL SITE of a narrow-declared callee — `lsl/asr` ahead of the `bl`, two Thumb
// instructions per site — so a wrong width here costs bytes the per-function differ cannot see.
//
// FUSED BEHIND A POOL LOAD. The prologue scan steps over a pool-loaded address, and a body cast
// with nothing else ahead of it — `gB = gW[(u8)a]` is `ldr r2,=gB / ldr r1,=gW / lsl r0,#24 /
// lsr r0,#22` — reaches it looking like a declaration once raise/extscale.ts has re-split the fused
// pair. The fold knows where the machine put that `lsl` and records it (`ScaleRecord.behindPool`),
// and `fused-behind-pool` reads the record: an unsigned declared parameter's `lsl` precedes every
// pool load in the benchmark's agbcc references (extscale.ts's header has the census). Only the
// fold's own extensions are judged this way; a plain cast's extension sits at its right shift,
// where its position says nothing about its `lsl`'s.
import { type Fn, type Op, type Value, replaceAllUsesWith, successorsOf } from '../ir/core';
import { CAST_WIDTHS, MATERIALIZING_OPS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';
import { type FnProto, declaredWidth } from '../proto';
import type { NarrowParamWitness } from '../target';

/** What the gates below judge: one entry parameter and the extension that reads it. */
export interface NarrowParamCandidate {
  /** the parameter the extension reads */
  param: Value;
  /** the extension's `width` attribute */
  width: number;
  /** the entry block has predecessors */
  entryIsJoin: boolean;
  /** the extension is in the entry block's PROLOGUE — see the scan in `narrowEntryParams` */
  inPrologue: boolean;
  /** reads of the RAW parameter anywhere in the function */
  uses: number;
  /** the width the caller's own prototype declares for this parameter, if it declares one */
  declared: number | undefined;
  /** the extension is one raise/extscale.ts re-split from a fused pair whose `shl` the machine ran
   *  behind a pool load — see FUSED BEHIND A POOL LOAD */
  fusedBehindPool: boolean;
  /** what this compiler's object shows for a narrow declaration (target.ts `narrowParamWitness`) */
  witness: NarrowParamWitness;
  /** the machine stored this parameter to a stack slot nothing reads back (`ParamObservation`) */
  homed: boolean;
  /** the machine put the parameter's own widened value back in its argument register (`ParamObservation`) */
  selfRedefined: boolean;
}

export const PARAM_WIDTH_GATES: readonly Gate<NarrowParamCandidate>[] = [
  {
    id: 'entry-is-join',
    why: "a joined entry's params are merge values, not the function's arguments",
    sound: true,
    guardedBy: 'param-width.test.ts: an entry block with a predecessor carries merge values, not arguments',
    rejects: (c) => c.entryIsJoin,
  },
  {
    id: 'param-typed',
    why: 'the pointer/aggregate recovery already decided this parameter',
    sound: true,
    guardedBy: 'param-width.test.ts: a parameter the pointer recovery already typed is left alone',
    rejects: (c) => c.param.type.kind !== 'unknown',
  },
  {
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'param-width.test.ts: a width no C type spells is refused',
    rejects: (c) => !CAST_WIDTHS.has(c.width),
  },
  {
    id: 'raw-reader',
    why: 'a reader of the un-extended register proves the declaration was wide',
    sound: true,
    guardedBy: 'param-width.test.ts: a second reader of the raw parameter proves the declaration was wide',
    rejects: (c) => c.uses !== 1,
  },
  {
    id: 'proto-width',
    why: "the caller's headers declare this parameter, and a declaration outranks an inference",
    sound: true,
    guardedBy: 'param-width.test.ts: a declared width the extension contradicts refuses the narrowing',
    rejects: (c) => c.declared !== undefined && c.declared !== c.width,
  },
  {
    id: 'not-prologue',
    why: 'an extension behind body code is where the SOURCE wrote the cast — and on a schedule that interleaves them, the refusing answer',
    sound: true,
    guardedBy: 'param-width.test.ts: an extension behind a nullary call is body code',
    rejects: (c) => !c.inPrologue,
  },
  {
    id: 'no-declaration-witness',
    why: 'this compiler spells a narrow declaration and a body cast the same way, so the asm decides nothing',
    sound: true,
    guardedBy:
      'param-width.test.ts: a compiler whose two spellings are one object refuses the narrowing, measured or not',
    rejects: (c) => c.witness === 'none',
  },
  {
    id: 'unhomed-param',
    why: 'this compiler homes a narrow DECLARED parameter, so the absent home store proves the declaration was wide',
    sound: true,
    guardedBy: 'param-width.test.ts: a homing compiler refuses the parameter it did not home',
    rejects: (c) => c.witness === 'home-store-and-in-place' && !c.homed,
  },
  {
    id: 'widened-elsewhere',
    why: 'this compiler widens a narrow DECLARED parameter in the argument register itself, so a widening that lands in a scratch register is not a declaration',
    sound: true,
    guardedBy:
      'param-width.test.ts: \u2026and refuses one it homed but widened SOMEWHERE ELSE \u2014 that is a 64-bit half',
    rejects: (c) => c.witness === 'home-store-and-in-place' && !c.selfRedefined,
  },
  {
    id: 'fused-behind-pool',
    why: 'a fused cast behind a pool load is body code if unsigned, and either width is the same object if signed',
    sound: true,
    guardedBy: 'extscale.test.ts: a body cast behind nothing but a pool load keeps its parameter wide',
    rejects: (c) => c.fusedBehindPool,
  },
];

/** How many times `v` is read anywhere in `fn` — op operands and branch arguments alike. */
function useCount(fn: Fn, v: Value): number {
  let n = 0;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      n += op.operands.filter((o) => o === v).length;
      for (const s of op.successors) {
        n += s.args.filter((a) => a === v).length;
      }
    }
  }
  return n;
}

/** Type an entry parameter at the width its prologue extension proves, and drop the extension.
 *  `witness` is what this compiler's object shows for a narrow declaration (target.ts
 *  `narrowParamWitness`); `self` is the prototype the caller supplied for THIS function, if any;
 *  `fusedBehindPool` is raise/extscale.ts's record of the extensions it re-split behind a pool load
 *  (`ScaleRecord.behindPool`). Returns the number of parameters narrowed. */
export function narrowEntryParams(
  fn: Fn,
  witness: NarrowParamWitness,
  self?: FnProto,
  gates: readonly Gate<NarrowParamCandidate>[] = PARAM_WIDTH_GATES,
  fusedBehindPool: ReadonlySet<Op> = new Set(),
): number {
  // ABSENT ⇒ NEITHER OBSERVATION, which is the refusing direction on a target that reads them: a
  // function nobody measured (parsed IR, a hand-built fn) is never narrowed on evidence never taken.
  const evidence = fn.paramEvidence;
  const entry = fn.blocks[0];
  const declared = Array.isArray(self?.params) ? self.params.map(declaredWidth) : [];
  const entryIsJoin = fn.blocks.some((b) => successorsOf(b).includes(entry));
  const params = new Set(entry.params);
  // The prologue: the entry block's leading parameter extensions, plus the `MATERIALIZING_OPS`
  // agbcc interleaves among them. Scanning stops at the first op that READS a value — body code
  // has run by then, and an extension behind body code is where the SOURCE wrote it.
  const prologue = new Set<Op>();
  for (const op of entry.ops) {
    if (MATERIALIZING_OPS.has(op.opcode)) {
      continue;
    }
    if ((op.opcode !== 'sext' && op.opcode !== 'zext') || !params.has(op.operands[0])) {
      break;
    }
    prologue.add(op);
  }
  let narrowed = 0;
  for (const op of [...entry.ops]) {
    if (op.opcode !== 'sext' && op.opcode !== 'zext') {
      continue;
    }
    const p = op.operands[0];
    if (!params.has(p)) {
      continue;
    }
    const width = op.attrs.width as number;
    const c: NarrowParamCandidate = {
      param: p,
      width,
      entryIsJoin,
      inPrologue: prologue.has(op),
      uses: useCount(fn, p),
      declared: declared[entry.params.indexOf(p)],
      fusedBehindPool: fusedBehindPool.has(op),
      witness,
      homed: evidence?.get(p)?.deadHome ?? false,
      selfRedefined: evidence?.get(p)?.selfRedefined ?? false,
    };
    if (firstRejection(gates, c) !== null) {
      continue;
    }
    p.type = T.int(width, op.opcode === 'sext');
    replaceAllUsesWith(fn, op.results[0], p);
    entry.ops.splice(entry.ops.indexOf(op), 1);
    narrowed++;
  }
  return narrowed;
}
