// asmlift — what a callee whose body is in the same input, or handed in from outside it, can read
// of its arguments.
//
// A callee nobody declared is called at a guessed arity (frontend/call-plan.ts, `fallbackArgc`),
// and on most ABIs `g()` and `g(x)` compile to the same caller bytes whenever x is already in the
// first argument register — so the caller cannot decide it. Where the callee's own body is in the
// input, the body can: an argument it never reads is no argument it can tell from a missing one.
// That answers only a question about a register at or past what the body reads (frontend/call-arity.ts
// `fallbackArgc`'s `bound`, and the dispatch pass-through gate in frontend/call-plan.ts). It never
// caps what the caller passes: a source call hands an unused parameter, or a K&R call extra
// arguments, all the same, and a register below the bound may be read.
//
// THE BOUND IS A LIFT OF THE CALLEE, NOT ITS LIFTED SIGNATURE. A callee's own lifted parameters
// rest on the same guess one level down: a forwarding thunk (`push {lr}; bl g; pop {r1}; bx r1`)
// lifts as `thk(void)` while g is undeclared, though it hands g every argument register it got. So
// every call inside the callee whose arity nothing lays out is taken at every argument register
// that may still hold the callee's own incoming value there (`LiftOptions.entryReadCalls`), and
// only then are the callee's entry parameters counted: an argument register or incoming stack word
// the body reads becomes one, and the frontend mints every argument slot below the highest one read
// (frontend/ssa.ts `mintArgSlotHoles`). That count is an UPPER bound on the argument words the
// callee reads. A register an earlier call destroyed on every path is not taken: it holds none of
// the callee's arguments, and a read of it would only make the lift refuse (`push {lr}; mov r0-r3,
// #0; bl g; bl h` would lose its bound so, though it reads none).
//
// A RETURN READS THE RETURN REGISTER. Where the target returns in its first argument register (ARM
// r0, PowerPC r3), a return that no path wrote that register for hands back the caller's first
// argument: `void *id(void *p) { return p; }` is a lone `blr` and `bx lr`, which no instruction reads,
// and its lift returns nothing and counts no parameter. So a return the lift left bare, on a path
// from the entry that makes no call (a call destroys the register), counts the first argument word
// as read, unless the callee's entry declares a void return. KNOWN GAP: a return in a register PAIR
// (r0:r1, r3:r4) that nothing declares is counted for its first register only.
//
// It answers nothing where:
//   - the callee is the function being lifted (its own declaration is a different question);
//   - the text the body is read from (the input, or a body handed in) defines no label of that
//     name: a `name:` line, an objdump `<name>:` header or a `glabel name` (the Thumb frontend lifts
//     a text with no such label whole, as one function, so a lift alone does not say the callee is
//     here);
//   - that text marks the callee `.weak`, which another definition may replace at link time;
//   - the callee does not lift, inside or outside the input (a lift that fails proves nothing);
//   - the callee's lift holds an `opaque` op: an instruction no frontend models is decoded only for
//     which registers it names, and which of them it reads is a guess (PowerPC `mtmsr r3` and MIPS
//     `mtc0 a0, c0_sr` each read the argument the decode takes for written), so a lift holding one
//     proves no more than one that fails;
//   - the callee makes a call through a register, whose arity nothing here can force;
//   - the callee's entry declares a struct or union return: one handed back through memory takes a
//     hidden pointer the lift reads as no entry parameter, so its count is one argument word short
//     (`struct Big mk(x)` reads r0 and r1 and lifts one parameter);
//   - the callee takes a floating-point parameter: the count is of PARAMETERS, and the callers ask
//     it as an argument-register INDEX. One per word holds only where every parameter is a word in
//     its own register: o32 passes a leading double in $f12, which shadows a0 and a1, so
//     `int hdx(double d, int x)` lifts two parameters and reads x from a2, index 2.
//
// A BODY OUTSIDE THE INPUT (`CalleeBodies`) answers only where the input defines no label of the
// callee's name, and is read under every rule above: a listing in the target frontend's own input
// format is lifted exactly as the same text placed in the input would be, with no side table of
// the input's (its relocations and jump tables are keyed by the input object's own sections). The
// driver that hands it in answers for what the input cannot say of it: that the definition is the
// one the link keeps (cli elf-bodies.ts reads the binding off the linked ELF's symbol table). An ARM
// body behind a Thumb veneer is not lifted at all: a straight-line scan of its words reads which
// argument registers it reads before writing them, and answers nothing for any other shape
// (frontend/arm-body.ts), and only on a target whose argument registers are the ones that scan
// counts (`scansArgumentsOf`, read off the ABI's `argRegs`).
// A disassembly of a linked ELF carries no relocations, and the MIPS and PowerPC frontends name a
// callee only by its relocation, so a listing body comes with the call relocations the driver
// names off the image's own symbol table (`CalleeBody.relocs`, or relocation lines in the text where
// the frontend reads them there): a call it cannot name stays unnamed, and the body does not lift.
// KNOWN GAP: an objdump listing (MIPS, PowerPC) shows no symbol binding, so a weak definition there
// is read as the one the link keeps. A weak copy of one inline definition is that definition; a weak
// default some other object overrides is not, and no row here has one.
import { type Block, type Fn, successorsOf } from '../ir/core';
import {
  type FnProto,
  type Prototypes,
  calleeDeclaration,
  declaredCallArgs,
  declaresAggregateReturn,
  declaresParams,
  declaresVoidReturn,
} from '../proto';
import { helperPrototypes } from '../runtime-helpers';
import type { TargetDescription } from '../target';
import { armArgumentWords, scansArgumentsOf } from './arm-body';
import type { Reloc } from './asmdata';
import { entryArgRank } from './ssa';
import { thumbEntryWordsFromHalfwords } from './thumb-entry';

/** A callee's body that the input does not hold, handed in by a driver that found it elsewhere
 *  (the linked ELF): `listing` is text in the target frontend's own input format holding the
 *  callee's label, with `relocs` the relocations an object of that text would carry in its side
 *  table (`AsmData.relocs`), for a frontend that reads them there and not in the text (MIPS);
 *  `arm` is the instruction words, from its entry, of the ARM body a Thumb caller enters through an
 *  interworking veneer, which no frontend here lifts and frontend/arm-body.ts scans instead;
 *  `thumb` is the first halfwords of a Thumb body, which bound nothing of its argument registers
 *  and only say which incoming stack words its entry loads (frontend/thumb-entry.ts). */
export type CalleeBody =
  | { kind: 'listing'; text: string; relocs?: readonly Reloc[] }
  | { kind: 'arm'; words: readonly number[] }
  | { kind: 'thumb'; halfwords: readonly number[] };

/** The bodies a driver found outside the input, keyed by callee (`DecompileOptions.calleeBodies`). */
export type CalleeBodies = Readonly<Record<string, CalleeBody>>;

/** One function of some text lifted under a table, with no bound of its own (`calleeBodyBounds`):
 *  the input, or a body handed in, with the relocations it carries (undefined for the input). */
export type CalleeLift = (
  callee: string,
  table: Prototypes,
  entryReadCalls: ReadonlySet<string>,
  text: string,
  relocs?: readonly Reloc[],
) => Fn;

/** The argument words callee `callee`'s own body can read at most, or `undefined` where its body
 *  proves nothing (frontend/frontend.ts `LiftOptions.calleeBodyBound`). */
export type CalleeBodyBound = (callee: string) => number | undefined;

/** Whether a call to a callee with entry `entry` asks its body at all, where nothing lays the call
 *  out: only where the entry states no parameter list. A list nothing can size, or a variadic one,
 *  still states parameters the call must be handed. */
export function asksCalleeBody(entry: FnProto | undefined): boolean {
  return !declaresParams(entry) && entry?.variadicParams === undefined;
}

/** What each callee's body says, read as a call to it first asks and kept for the rest: the
 *  register bound, and the incoming stack words it loads (`CalleeStackWords` below), off ONE lift.
 *  `lift` lifts one function of a text (the input, or a body in `external`) under a table, with no
 *  bound of its own: one level of bodies is read, never the callee's callees'. `entry` is the
 *  target frontend's entry scan (`Frontend.entryStackWords`), asked only of a body that does not
 *  lift. */
export function calleeBodyReads(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  external?: CalleeBodies,
  entry?: EntryStackWords,
): { bound: CalleeBodyBound; stackWords: CalleeStackWords } {
  const memo = new Map<string, BodyReads>();
  const read = (callee: string): BodyReads => {
    if (!memo.has(callee)) {
      memo.set(callee, bodyReads(self, callee, asm, target, prototypes, lift, external, entry));
    }
    return memo.get(callee)!;
  };
  return { bound: (callee) => read(callee).bound, stackWords: (callee) => read(callee).stack };
}

/** {@link calleeBodyReads}'s register bound alone. */
export function calleeBodyBounds(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  external?: CalleeBodies,
): CalleeBodyBound {
  return calleeBodyReads(self, asm, target, prototypes, lift, external).bound;
}

/** Whether `text` defines a label named `callee`: a `name:` line, an objdump `<name>:` header or a
 *  `glabel name`. */
export function definesLabel(text: string, callee: string): boolean {
  const name = escaped(callee);
  return new RegExp(`^(?:\\s*${name}\\s*:|[0-9a-fA-F]+ <${name}>:|\\s*glabel\\s+${name}\\s*$)`, 'm').test(text);
}

/** Every name a `.weak` directive marks, in each spelling GNU as reads: one name or a comma-separated
 *  list (`.weak other, cb`), with a comment after it (`@` on ARM, `#` on MIPS and PowerPC). */
function weakNames(asm: string): Set<string> {
  const out = new Set<string>();
  for (const m of asm.matchAll(/^\s*\.weak\s+([^\n@#;]*)/gm)) {
    m[1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .forEach((n) => out.add(n));
  }
  return out;
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a callee's entry says of its return, and nothing of its parameters or of its own context
 *  bound: those are what is being measured. */
const returnOnly = (p: FnProto | undefined): FnProto => {
  const out: FnProto = {};
  if (p?.returnsVoid !== undefined) {
    out.returnsVoid = p.returnsVoid;
  }
  if (p?.returns !== undefined) {
    out.returns = p.returns;
  }
  if (p?.returnLayout !== undefined) {
    out.returnLayout = p.returnLayout;
  }
  return out;
};

/** What one callee's body answers: `bound`, the argument words it reads at most, and `stack`, the
 *  incoming stack words it loads (`CalleeStackWords`); each undefined where the body proves none. */
interface BodyReads {
  readonly bound?: number;
  readonly stack?: number;
}

function bodyReads(
  self: string,
  callee: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  external: CalleeBodies | undefined,
  entry: EntryStackWords | undefined,
): BodyReads {
  if (callee === self || declaresAggregateReturn(Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined)) {
    return {};
  }
  // a body that lifts answers both; one that does not answers its entry's loads, and no bound
  const lifted = (text: string, relocs?: readonly Reloc[]): BodyReads => {
    const got = liftedReads(callee, text, target, prototypes, lift, relocs);
    // a scan of the entry's stack loads sees no register read, so where the ABI can skip an
    // argument register (`evenWordAlignedArgs`) it cannot say the registers are all arguments
    return got ?? { stack: target.evenWordAlignedArgs === true ? undefined : entry?.(callee, text) };
  };
  if (definesLabel(asm, callee)) {
    return weakNames(asm).has(callee) ? {} : lifted(asm);
  }
  const body = external !== undefined && Object.hasOwn(external, callee) ? external[callee] : undefined;
  if (body?.kind === 'thumb') {
    return { stack: scansArgumentsOf(target) ? thumbEntryWordsFromHalfwords(body.halfwords) : undefined };
  }
  if (body?.kind === 'arm') {
    return scansArgumentsOf(target)
      ? {
          bound: armArgumentWords(
            body.words,
            !declaresVoidReturn(Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined),
          ),
        }
      : {};
  }
  if (body === undefined || !definesLabel(body.text, callee) || weakNames(body.text).has(callee)) {
    return {};
  }
  return lifted(body.text, body.relocs);
}

/** The entry parameters a lift of `callee` out of `text` counts, once every call in it nothing lays
 *  out is taken at every argument register, and one past the highest incoming stack word among them
 *  (`entryArgRank`): an argument slot past the registers is minted only below a stack word the body
 *  loads, so that count is a word it reads. Undefined where no lift proves it. */
function liftedReads(
  callee: string,
  text: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  relocs?: readonly Reloc[],
): BodyReads | undefined {
  const helpers = helperPrototypes(target);
  const table: Prototypes = { ...prototypes, [callee]: returnOnly(prototypes[callee]) };
  const forced = new Set<string>();
  // Each round forces the calls the last lift guessed and lifts again; a round that forces nothing
  // new is the answer. The forced set only grows, so this ends.
  for (;;) {
    let fn: Fn;
    try {
      fn = lift(callee, table, forced, text, relocs);
    } catch {
      return undefined;
    }
    const guessed = new Set<string>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'opaque') {
          return undefined;
        }
        if (op.opcode !== 'call') {
          continue;
        }
        const at = op.attrs.target;
        if (typeof at !== 'string') {
          return undefined;
        }
        if (!forced.has(at) && declaredCallArgs(calleeDeclaration(at, table, helpers), target) === undefined) {
          guessed.add(at);
        }
      }
    }
    if (guessed.size === 0) {
      const { params } = fn.blocks[0];
      if (params.some((p) => p.type.kind === 'float')) {
        return undefined;
      }
      const passesFirst =
        target.returnReg === target.argRegs[0] && !declaresVoidReturn(table[callee]) && returnsUntouched(fn);
      const top = Math.max(0, ...params.map((p) => (entryArgRank(p) ?? -1) + 1));
      const stack = Math.max(0, top - target.argRegs.length);
      return {
        bound: Math.max(params.length, passesFirst ? 1 : 0),
        stack:
          stack > 0 && target.evenWordAlignedArgs === true && !readsEveryArgReg(fn, target, forced) ? undefined : stack,
      };
    }
    // an entry whose parameter list nothing can lay out (an unsizable or variadic one) is dropped
    // too, so the call is taken at the incoming values rather than at what the guess counted
    for (const g of guessed) {
      forced.add(g);
      table[g] = returnOnly(Object.hasOwn(table, g) ? table[g] : undefined);
    }
  }
}

/** Whether the lifted body READS every argument register: each is an entry parameter some op or
 *  edge uses. Below a stack word the body loads, every register slot is minted a parameter
 *  (frontend/ssa.ts `mintArgSlotHoles`) whether or not it is read, which counts the slots right
 *  only on an ABI that never skips one. Where an 8-aligned argument starts at an even word
 *  (`evenWordAlignedArgs`: O32 `int f(int, int, int, long long)` leaves a3 empty and passes the
 *  `long long` at 16(sp)), a minted register may be that skipped word, which no caller writes;
 *  taken as an argument it hands the callee whatever the caller left there, and gives a caller
 *  that never wrote it a parameter it does not have. So there the stack words count only where
 *  every register below them is one the body reads. A call in `forced` (taken at every argument
 *  register its incoming value may still sit in, for the register bound) is no read: it takes the
 *  skipped register too. */
function readsEveryArgReg(fn: Fn, target: TargetDescription, forced: ReadonlySet<string>): boolean {
  const used = new Set<unknown>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'call' && typeof op.attrs.target === 'string' && forced.has(op.attrs.target)) {
        continue;
      }
      op.operands.forEach((v) => used.add(v));
      op.successors.forEach((e) => e.args.forEach((v) => used.add(v)));
    }
  }
  const read = new Set(fn.blocks[0].params.filter((p) => used.has(p)).map((p) => entryArgRank(p)));
  return target.argRegs.every((_, k) => read.has(k));
}

/** Whether some return of `fn` hands back nothing the lift names (a bare `ret`) on a path from the
 *  entry that makes no call: there the return register still holds what the caller left in it. */
function returnsUntouched(fn: Fn): boolean {
  const callFree = new Set<Block>();
  const work = fn.blocks.length === 0 ? [] : [fn.blocks[0]];
  while (work.length > 0) {
    const b = work.pop()!;
    if (callFree.has(b) || b.ops.some((o) => o.opcode === 'call')) {
      continue;
    }
    callFree.add(b);
    work.push(...successorsOf(b));
  }
  return [...callFree].some((b) => b.ops.some((o) => o.opcode === 'ret' && o.operands.length === 0));
}

/** WHAT A CALLEE'S BODY SAYS OF ITS STACK ARGUMENTS: one past the highest incoming stack word it is
 *  proven to load, a LOWER bound on the words a call to it takes (frontend/stackargs.ts, "THE
 *  CALLEE'S BODY"), or `undefined` where it proves none. Read under the rules of the register bound
 *  and answering nothing where they do. Where the body lifts it is the lift's count (the whole body,
 *  every path); where it does not, the frontend's scan of its straight-line entry
 *  (`Frontend.entryStackWords`, or a Thumb body's halfwords: frontend/thumb-entry.ts), which sees
 *  only the words loaded before the first branch, and so says less. */
export type CalleeStackWords = (callee: string) => number | undefined;

/** Reads the incoming stack words the straight-line entry of `callee` in a text of the frontend's
 *  input format loads (`Frontend.entryStackWords`). */
export type EntryStackWords = (callee: string, text: string) => number | undefined;
