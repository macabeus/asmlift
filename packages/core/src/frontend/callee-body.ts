// asmlift — what a callee whose body is in the same input, or handed in from outside it, can read
// of its arguments.
//
// A callee nobody declared is called at a guessed arity (frontend/call-plan.ts, `fallbackArgc`),
// and on most ABIs `g()` and `g(x)` compile to the same caller bytes whenever x is already in the
// first argument register — so the caller cannot decide it. Where the callee's own body is in the
// input, the body can: an argument it never reads is no argument it can tell from a missing one.
// That answers only a question about a register at or past what the body reads (frontend/call-arity.ts
// `fallbackArgc`'s `bound`, and the dispatch pass-through gate in frontend/call-plan.ts). It never
// caps what an emitted call passes: a source call hands an unused parameter, or a K&R call extra
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
// #0; bl g; bl h` would lose its bound so, though it reads none). Nor is a register at or past what
// that inner call's own callee's body reads, where the body lift is handed that body (call-plan.ts
// `entryWords`): no such register is read there, so the count stays an upper bound. That caps an
// entry-read call inside a body lift only, never an emitted call.
//
// A BODY IS LIFTED READING ITS OWN CALLEES' BODIES, at every depth (`calleeBodyReads`): a body that
// stages stack words for a call nothing declares lifts only where that callee's body sizes the
// block, and the call chain to that callee may be any number of wrappers long. Each body is lifted
// once (a body on a call cycle twice, below). The function being lifted at the top is read as a
// body that does not lift, by the frontend's scans (`unliftedReads`), never by a lift of itself.
// Bodies on a call cycle below it (a strongly connected component of the bodies read) are each
// lifted reading the others, and itself, the same way: a lift of one reading another member's lift
// would read it before that answer exists, so what it says would hang on which member a call asked
// first, and the answer must be the callee's alone.
//
// A RETURN READS THE RETURN REGISTER. Where the target returns in its first argument register (ARM
// r0, PowerPC r3), a return that no path wrote that register for hands back the caller's first
// argument: `void *id(void *p) { return p; }` is a lone `blr` and `bx lr`, which no instruction reads,
// and its lift returns nothing and counts no parameter. So a return the lift left bare, on a path
// from the entry that makes no call (a call destroys the register), counts the first argument word
// as read, unless the callee's entry declares a void return. Not a return the frontend left bare
// because it branched through that register (`ret` `viaReturnReg`, ir/opcodes.ts): agbcc's
// `pop {r0}; bx r0` hands back the return address, and the Thumb frontend reads r0 at every other
// return, so a first argument handed back there is already a parameter. KNOWN GAP: a return in a
// register PAIR (r0:r1, r3:r4) that nothing declares is counted for its first register only.
//
// It answers nothing where:
//   - the callee is the function being lifted, or a body on the same call cycle as the one being
//     lifted (its own declaration is a different question), save what a body that does not lift
//     answers: the incoming stack words its own entry loads, which size a call to itself
//     (`unliftedReads`);
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
//   - the callee makes a call through a register, whose arity nothing here can force, unless the
//     register itself bounds it (`ARGS_BOUND_BY_ADDRESS`, ir/core.ts): agbcc's `bl _call_via_r1`
//     takes at most r0 and no stack word, and the lowering already reads every register below the
//     address, which is what forcing a named call does;
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
import {
  ARGS_BOUND_BY_ADDRESS,
  type Block,
  type Fn,
  type Op,
  type Value,
  callArgs,
  calleeValue,
  successorsOf,
} from '../ir/core';
import { OPCODES } from '../ir/opcodes';
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
import type { Frontend } from './frontend';
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
 *  the input, or a body handed in, with the relocations it carries (undefined for the input), and
 *  `readers`, what that lift is to be handed of its own callees' bodies (`LiftOptions.calleeBody`):
 *  the same readers, so the reading goes as deep as the calls do (`calleeBodyReads`). A lift that
 *  ignores them reads no body below the first level. */
export type CalleeLift = (
  callee: string,
  table: Prototypes,
  entryReadCalls: ReadonlySet<string>,
  text: string,
  relocs: readonly Reloc[] | undefined,
  readers: CalleeBodyReaders,
) => Fn;

/** The argument words callee `callee`'s own body can read at most, or `undefined` where its body
 *  proves nothing (frontend/frontend.ts `LiftOptions.calleeBody`). */
export type CalleeBodyBound = (callee: string) => number | undefined;

/** Whether a call to a callee with entry `entry` asks its body at all, where nothing lays the call
 *  out: only where the entry states no parameter list. A list nothing can size, or a variadic one,
 *  still states parameters the call must be handed. */
export function asksCalleeBody(entry: FnProto | undefined): boolean {
  return !declaresParams(entry) && entry?.variadicParams === undefined;
}

/** Every reader of a callee's body, off one lift of it (`calleeBodyReads`): what a lift is handed as
 *  `LiftOptions.calleeBody`, and the lowering as `callDeclarations`' `calleeBody`. One object, so a
 *  reader added here reaches every frontend that passes the object on. */
export type CalleeBodyReaders = {
  bound: CalleeBodyBound;
  stackWords: CalleeStackWords;
  returnsNoHiddenPointer: CalleeReturnsNoHiddenPointer;
  readsFirstArgument: CalleeReadsFirstArgument;
};

/** {@link calleeBodyReads}'s readers, and `bodiesUnder`: each callee whose body answered something
 *  (a bound, stack words, or a yes) to the lift of `callee`'s body, once that body was read. */
export type CalleeBodyReads = CalleeBodyReaders & {
  bodiesUnder: (callee: string) => ReadonlySet<string>;
};

/** What each callee's body says, read as a call to it first asks and kept for the rest: the
 *  register bound, the incoming stack words it loads (`CalleeStackWords` below), whether it is no
 *  struct return through a hidden pointer (`CalleeReturnsNoHiddenPointer` below) and whether it
 *  reads its first argument register (`CalleeReadsFirstArgument` below), off ONE lift.
 *  `lift` lifts one function of a text (the input, or a body in `external`) under a table, with no
 *  bound of its own, handed these same readers for its own callees, so a body is read at whatever
 *  depth a call first asks it and once only. `self` answers as a body that does not lift
 *  (`unliftedReads`), and so does each body of a strongly connected component of more than one body
 *  to the lift of a body of that component, which is lifted again once the component closes: a
 *  cycle ends, and no answer depends on the order the calls ask in. `frontend` is what
 *  the target frontend says of its own lifts: its entry scan (`Frontend.entryStackWords`) and its
 *  return scan (`Frontend.returnsThroughReturnReg`), asked only of a body that does not lift. */
export function calleeBodyReads(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  external?: CalleeBodies,
  frontend?: Pick<Frontend, 'entryStackWords' | 'returnsThroughReturnReg'>,
): CalleeBodyReads {
  const memo = new Map<string, BodyReads>();
  const under = new Map<string, Set<string>>();
  const unlifted = (callee: string): BodyReads =>
    bodyReads(callee, asm, target, prototypes, undefined, external, frontend);
  // Tarjan's strongly connected components over the bodies read (`self` is no node: it is always
  // read unlifted): each body's visit index and low link, the bodies whose lift is under way
  // (innermost last), and the bodies visited whose component is still open
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const lifting: string[] = [];
  const open: string[] = [];
  const onOpen = new Set<string>();
  // each body of a closed component of more than one body, by component
  const componentOf = new Map<string, number>();
  const read = (callee: string): BodyReads => {
    const reader = lifting.at(-1);
    if (
      callee === self ||
      (reader !== undefined && componentOf.has(callee) && componentOf.get(callee) === componentOf.get(reader))
    ) {
      return unlifted(callee);
    }
    const link = (to: number): void => {
      if (reader !== undefined) {
        low.set(reader, Math.min(low.get(reader)!, to));
      }
    };
    if (index.has(callee)) {
      if (onOpen.has(callee)) {
        link(index.get(callee)!);
      }
      // a body whose lift is under way has no answer yet; its component's answer replaces this one
      return memo.get(callee) ?? unlifted(callee);
    }
    index.set(callee, index.size);
    low.set(callee, index.get(callee)!);
    open.push(callee);
    onOpen.add(callee);
    readLifted(callee);
    link(low.get(callee)!);
    if (low.get(callee) === index.get(callee)) {
      const component = open.splice(open.lastIndexOf(callee));
      component.forEach((c) => onOpen.delete(c));
      // bodies that call each other: each lift above read another member before that one's answer
      // existed, so what it says hangs on which member was asked first. Each is lifted again reading
      // every member, itself included, as a body that does not lift, and every other body by its
      // settled answer, which no member's answer changes.
      if (component.length > 1) {
        component.forEach((c) => componentOf.set(c, index.get(callee)!));
        component.forEach(readLifted);
      }
    }
    return memo.get(callee)!;
  };
  const readLifted = (callee: string): void => {
    lifting.push(callee);
    try {
      const asked = new Set<string>();
      under.set(callee, asked);
      const bodyLift: BodyLift = (c, table, entryReadCalls, text, relocs) =>
        lift(c, table, entryReadCalls, text, relocs, recording(asked));
      memo.set(callee, bodyReads(callee, asm, target, prototypes, bodyLift, external, frontend));
    } finally {
      lifting.pop();
    }
  };
  // the readers a body's lift is handed, noting each callee whose body answered it something
  const recording = (asked: Set<string> | undefined): CalleeBodyReaders => {
    const noted = <T>(callee: string, said: T, answered: boolean): T => {
      if (answered) {
        asked?.add(callee);
      }
      return said;
    };
    return {
      bound: (callee) => {
        const words = read(callee).bound;
        return noted(callee, words, words !== undefined);
      },
      stackWords: (callee) => {
        const words = read(callee).stack;
        return noted(callee, words, words !== undefined);
      },
      returnsNoHiddenPointer: (callee) => {
        const yes = read(callee).noHiddenPointer === true;
        return noted(callee, yes, yes);
      },
      readsFirstArgument: (callee) => {
        const yes = read(callee).readsFirst === true;
        return noted(callee, yes, yes);
      },
    };
  };
  const none: ReadonlySet<string> = new Set();
  return { ...recording(undefined), bodiesUnder: (callee) => under.get(callee) ?? none };
}

/** {@link calleeBodyReads}'s register bound alone. */
export function calleeBodyBounds(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: CalleeLift,
  external?: CalleeBodies,
  frontend?: Pick<Frontend, 'entryStackWords' | 'returnsThroughReturnReg'>,
): CalleeBodyBound {
  return calleeBodyReads(self, asm, target, prototypes, lift, external, frontend).bound;
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
 *  incoming stack words it loads (`CalleeStackWords`), each undefined where the body proves none;
 *  `noHiddenPointer` and `readsFirst`, each present only where the body proves it. */
interface BodyReads {
  readonly bound?: number;
  readonly stack?: number;
  /** it returns no struct through a hidden pointer (`CalleeReturnsNoHiddenPointer`) */
  readonly noHiddenPointer?: true;
  /** it reads its first argument register's incoming value (`CalleeReadsFirstArgument`) */
  readonly readsFirst?: true;
}

/** A {@link CalleeLift} with its readers already bound. */
type BodyLift = (
  callee: string,
  table: Prototypes,
  entryReadCalls: ReadonlySet<string>,
  text: string,
  relocs?: readonly Reloc[],
) => Fn;

/** What `callee`'s body answers, read off the input or a body handed in. `lift` undefined reads it as
 *  a body that does not lift (`unliftedReads`): the function being lifted, whose lift would be the
 *  one under way, or, to the lift of a body on a call cycle, a body of that cycle
 *  (`calleeBodyReads`). */
function bodyReads(
  callee: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: BodyLift | undefined,
  external: CalleeBodies | undefined,
  frontend: Pick<Frontend, 'entryStackWords' | 'returnsThroughReturnReg'> | undefined,
): BodyReads {
  if (declaresAggregateReturn(Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined)) {
    return {};
  }
  // a body that lifts answers every reader; one that does not, or is not lifted, answers what
  // `unliftedReads` scans
  const lifted = (text: string, relocs?: readonly Reloc[]): BodyReads =>
    (lift === undefined ? undefined : liftedReads(callee, text, target, prototypes, lift, relocs)) ??
    unliftedReads(callee, text, target, frontend);
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

/** WHAT A BODY ANSWERS WITHOUT ITS LIFT: the incoming stack words its straight-line entry loads, and
 *  whether the frontend's scan finds a return through the return register, and no bound. Asked of a
 *  body that does not lift, of the function being lifted, and of a body of the same call cycle as
 *  the body being lifted: a CALL TO ITSELF is sized so, by the frontend's scan
 *  (`Frontend.entryStackWords`), never by a lift of itself, which would be the lift being made.
 *  A scan of the entry's stack loads sees no register read, so where the ABI can skip an argument
 *  register (`evenWordAlignedArgs`) it cannot say the registers are all arguments, and says
 *  nothing. */
function unliftedReads(
  callee: string,
  text: string,
  target: TargetDescription,
  frontend: Pick<Frontend, 'entryStackWords' | 'returnsThroughReturnReg'> | undefined,
): BodyReads {
  const stack = target.evenWordAlignedArgs === true ? undefined : frontend?.entryStackWords?.(callee, text);
  const scanned =
    target.compilerBehaviors.structReturnHandsBackPointer === true &&
    frontend?.returnsThroughReturnReg?.(callee, text, target) === true;
  return { stack, ...(scanned ? { noHiddenPointer: true } : {}) };
}

/** The entry parameters a lift of `callee` out of `text` counts, once every call in it nothing lays
 *  out is taken at every argument register that may hold an incoming value (short of what its own
 *  callee's body is proven not to read), and one past the highest incoming stack word among them
 *  (`entryArgRank`): an argument slot past the registers is minted only below a stack word the body
 *  loads, so that count is a word it reads. Undefined where no lift proves it. */
function liftedReads(
  callee: string,
  text: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: BodyLift,
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
          if (op.attrs[ARGS_BOUND_BY_ADDRESS] === true) {
            continue;
          }
          return undefined;
        }
        if (!forced.has(at) && declaredCallArgs(calleeDeclaration(at, table, helpers), target) === undefined) {
          guessed.add(at);
        }
      }
    }
    if (guessed.size === 0) {
      const noHiddenPointer = handsBackNoPointer(fn, target) ? ({ noHiddenPointer: true } as const) : {};
      const { params } = fn.blocks[0];
      if (params.some((p) => p.type.kind === 'float')) {
        return noHiddenPointer;
      }
      const passesFirst =
        target.returnReg === target.argRegs[0] && !declaresVoidReturn(table[callee]) && returnsUntouched(fn);
      const top = Math.max(0, ...params.map((p) => (entryArgRank(p) ?? -1) + 1));
      const stack = Math.max(0, top - target.argRegs.length);
      return {
        ...(readsFirstArgument(fn, forced) ? { readsFirst: true as const } : {}),
        bound: Math.max(params.length, passesFirst ? 1 : 0),
        stack:
          stack > 0 && target.evenWordAlignedArgs === true && !readsEveryArgReg(fn, target, forced) ? undefined : stack,
        ...noHiddenPointer,
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

/** Whether some return of `fn` hands back nothing the lift names (a bare `ret`, not one that branched
 *  through the return register: `viaReturnReg`) on a path from the entry that makes no call: there the
 *  return register still holds what the caller left in it. */
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
  return [...callFree].some((b) =>
    b.ops.some((o) => o.opcode === 'ret' && o.operands.length === 0 && o.attrs.viaReturnReg !== true),
  );
}

/** WHETHER A CALLEE'S BODY READS ITS FIRST ARGUMENT REGISTER'S INCOMING VALUE: a LOWER bound on what
 *  it reads, where the register bound (`CalleeBodyBound`) is an upper one. An op reads it, directly
 *  or through a join no value the body wrote also flows into (one that does is an uninitialised
 *  local's bytes as much as a reassigned parameter's, and reads as neither; a value computed from
 *  the incoming one and literals alone, a literal being a constant or a value computed from
 *  constants alone, is no such write, so a loop-carried `p++` or `a += 300` still reads through
 *  its header), other than a return,
 *  and other than as an argument of a call the lift forced to every register, or of one through a
 *  register that bounds it (`ARGS_BOUND_BY_ADDRESS`) whose address arrives in a block parameter:
 *  either is handed the register whatever the source passed, and a return hands r0 back whether or
 *  not it was a parameter (`int g(void)` returns through `pop {r1}; bx r1` too). The address is what decides a bound call: agbcc calls an address
 *  it computes or loads through the first register past the arguments (compiled at -O1 and -O2,
 *  `s->fn()`, `tab[i]()` and `gS.fn()` with the pointer in r1 all load into r0 and call
 *  `_call_via_r0`; -O0 uses r4), so `bl _call_via_r1` on a loaded address passes r0. One left where
 *  it arrived is called in place: `void h(int u, void (*fn)(void)) { fn(); }` is `bl _call_via_r1`
 *  with r0 never passed, and a join may carry such an address round a loop. Read off the same
 *  lift as the register bound, and false wherever that answers nothing. Asked where the trim would
 *  drop an earlier call's result left in that register (frontend/call-plan.ts), which the call is
 *  then passed: it takes at least that word, and nothing else wrote it.
 *  KNOWN GAP: a body that only forwards the register to an undeclared callee reads nothing here, so
 *  the result is dropped as with no body at all.
 *  KNOWN COST: an uninitialised local in that register stepped by a literal alone has the bytes of a
 *  stepped parameter (agbcc -O2's `void u(void) { unsigned char x; while (gk) { gk--; x++; } gy =
 *  x; }` is `void u(int x)` stepping `x = (u8)(x + 1)`), so it reads as one and `h(); u();` lifts as
 *  `u(h())`: the mirror of the reassigned parameter read as none. */
export type CalleeReadsFirstArgument = (callee: string) => boolean;

function readsFirstArgument(fn: Fn, forced: ReadonlySet<string>): boolean {
  const first = fn.blocks[0]?.params.find((p) => entryArgRank(p) === 0);
  if (first === undefined) {
    return false;
  }
  // every join the incoming value reaches, then only those it alone reaches: a join that merges it
  // with a value the body wrote is what an uninitialised local in that register is, as much as a
  // reassigned parameter (`void g(void) { int x; if (gk) x = gk * 3; gy = x; }` stores the entry r3
  // on mwcc, as agbcc's `while (gk) x = --gk; gy = x + 1;` adds to the entry r0, the same bytes as
  // `void g(int a) { if (gk) a = 5; gy = a; }`), so a read of it proves no parameter. A value the
  // body computes from that value alone (with literals) carries it as much as an edge does: a
  // loop-carried parameter reaches its header joined with its own step (agbcc's `*p++ = 7` and
  // `a++`, mwcc's `p += 3`), which an uninitialised local, merged with what the body loaded or set,
  // is not
  const edges: [into: Value, from: Value][] = [];
  const literals = new Set<Value>();
  const steps: Op[] = [];
  for (const b of fn.blocks) {
    for (const o of b.ops) {
      const sig = (OPCODES as Record<string, { effects?: boolean; reads?: boolean } | undefined>)[o.opcode];
      if (o.opcode === 'const' || o.opcode === 'fconst') {
        o.results.forEach((r) => literals.add(r));
      } else if (o.results.length === 1 && o.operands.length > 0 && sig?.effects !== true && sig?.reads !== true) {
        steps.push(o);
      }
    }
  }
  // a step computed from literals alone is one too: agbcc builds a constant past imm8 as
  // `mov r2, #0x96; lsl r2, r2, #0x1` (`a += 300`), hoisted above the loop
  for (let grew = true; grew;) {
    grew = false;
    for (const o of steps) {
      if (!literals.has(o.results[0]) && o.operands.every((v) => literals.has(v))) {
        literals.add(o.results[0]);
        grew = true;
      }
    }
  }
  for (const b of fn.blocks) {
    for (const o of b.ops) {
      for (const e of o.successors) {
        e.args.forEach((a, i) => {
          const into = e.block.params[i];
          if (into !== undefined) {
            edges.push([into, a]);
          }
        });
      }
    }
  }
  const names = new Set<Value>([first]);
  const carried = (o: Op): boolean =>
    o.operands.some((v) => names.has(v)) && o.operands.every((v) => names.has(v) || literals.has(v));
  for (let grew = true; grew;) {
    grew = false;
    for (const [into, from] of edges) {
      if (names.has(from) && !names.has(into)) {
        names.add(into);
        grew = true;
      }
    }
    for (const o of steps) {
      if (!names.has(o.results[0]) && carried(o)) {
        names.add(o.results[0]);
        grew = true;
      }
    }
  }
  for (let shrank = true; shrank;) {
    shrank = false;
    for (const [into, from] of edges) {
      if (into !== first && names.has(into) && !names.has(from)) {
        names.delete(into);
        shrank = true;
      }
    }
    for (const o of steps) {
      if (names.has(o.results[0]) && !carried(o)) {
        names.delete(o.results[0]);
        shrank = true;
      }
    }
  }
  const blockParams = new Set<Value>(fn.blocks.flatMap((b) => b.params));
  const inPlace = (o: Op): boolean => {
    const at = calleeValue(o);
    return at === undefined || blockParams.has(at);
  };
  const handedOn = (o: Op): ReadonlySet<Value> =>
    o.opcode === 'call' &&
    ((o.attrs[ARGS_BOUND_BY_ADDRESS] === true && inPlace(o)) ||
      (typeof o.attrs.target === 'string' && forced.has(o.attrs.target)))
      ? new Set(callArgs(o))
      : new Set();
  return fn.blocks.some((b) =>
    b.ops.some((o) => {
      if (o.opcode === 'ret') {
        return false;
      }
      const passed = handedOn(o);
      return o.operands.some((v) => names.has(v) && !passed.has(v));
    }),
  );
}

/** WHETHER A CALLEE'S BODY PROVES IT RETURNS NO STRUCT THROUGH A HIDDEN POINTER, which no caller can
 *  tell: a caller's out-parameter at argument 0 and a struct return through memory are the same
 *  instructions (frontend/frame-objects.ts `hiddenReturnPointerStands`). The callee can, where its
 *  compiler hands the pointer back in the return register at every return
 *  (`compilerBehaviors.structReturnHandsBackPointer`, measured true on agbcc and the three O32
 *  compilers): a return that hands back nothing, or a constant, is then no return of such a function.
 *  On agbcc the first is the `pop {r0}; bx r0` of a function that pushed lr, where r0 holds the return
 *  address (`ret` `viaReturnReg`): compiled at -O0, -O1, -O2 and -Os, `struct R mk(int *)` returns
 *  through `pop {r1}; bx r1` with r0 still the pointer, and agbcc pops into r0 only where no value is
 *  returned. On O32 it is a return no path wrote v0 for, or one of a constant left in v0, where the
 *  struct return is `move v0, a0`.
 *  Read off the same lift as the register bound, under its rules, and answering false wherever they
 *  answer nothing, save one: a body that does not lift is still asked whether some return it reaches
 *  branches through the return register (`Frontend.returnsThroughReturnReg`), which needs no lift of
 *  what it computes. PowerPC's mwcc clobbers r3 before the `blr` (the field is false), so it never
 *  answers there. */
export type CalleeReturnsNoHiddenPointer = (callee: string) => boolean;

/** Whether some return of `fn` hands back no value, or a constant, on a target whose compiler hands a
 *  hidden struct pointer back at every return of a function that takes one
 *  (`CalleeReturnsNoHiddenPointer`): neither is the pointer that function was handed. A value loaded
 *  or computed is not asked (a reload of the pointer's spill is the pointer). A bare `ret` hands
 *  back nothing only where it branched through the return register (`viaReturnReg`) or that
 *  register is no argument register: one that returns in its first argument register and names
 *  nothing returns that register untouched (`returnsUntouched`), which in a function handed a
 *  hidden pointer is the pointer. */
function handsBackNoPointer(fn: Fn, target: TargetDescription): boolean {
  if (target.compilerBehaviors.structReturnHandsBackPointer !== true) {
    return false;
  }
  const constants = new Set(
    fn.blocks.flatMap((b) => b.ops.filter((o) => o.opcode === 'const').flatMap((o) => o.results)),
  );
  const bareIsNothing = (o: Op): boolean => o.attrs.viaReturnReg === true || target.returnReg !== target.argRegs[0];
  return fn.blocks.some((b) =>
    b.ops.some(
      (o) => o.opcode === 'ret' && (o.operands.length === 0 ? bareIsNothing(o) : constants.has(o.operands[0])),
    ),
  );
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
