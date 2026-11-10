// asmlift — A GUESSED CALL ARITY: how many argument registers a call to a callee nobody declared
// takes, read off what reaches the call (`fallbackArgc`, asked by frontend/call-plan.ts
// `CallDeclarations.lower`), and the cut of that guess by what the call's ABI destroys
// (`trimClobberedCallArgs`, run from the SSA builder's `finish` in frontend/ssa.ts), with the
// narrower `/setup-args` reading the ranked tower offers beside it (rank.ts).
//
// The rest of the arity evidence lives with what it reads: a declaration answers a call's arity
// outright and decides a gap (frontend/call-plan.ts), a callee whose body is in the input bounds
// it (frontend/callee-body.ts), the function's own declaration bounds its own entry
// (pipeline.ts `readDroppedArgRegs`), and rank.ts offers and gates `/setup-args`.
// frontend/ssa.ts re-exports every name exported here, so importers of `./ssa` see no change. The
// side tables `setupArgc` and `discardsPassedResult` are this module's alone: written by the trim,
// read by the narrowing.
import { type Block, type Fn, type Op, type Value, callArgs, defOpMap, terminator, truncateCallArgs } from '../ir/core';
import { pruneDeadParams } from '../ir/simplify';
import { type FrontendRefusal, FrontendUnsupportedError } from './errors';

// ── a guessed call arity: counted by `CallDeclarations.lower`, trimmed by `finish` ──

/** Best-effort call arity when a callee has no prototype: the count of contiguous argument
 *  registers with a value reaching the call's block. Correct when the arguments are set up in
 *  the calling block; it can under-count pass-through parameters — which is why a prototype's
 *  declared `params` is authoritative when available.
 *
 *  `accept` says which definitions are values (`SsaBuilder.hasReachingDef`). A pending high half
 *  is a def but not a value, and counted it raises the arity: a `lis` hoisted into the prologue
 *  leaves its half in r4 across an intervening call and makes `strlen(s)` into
 *  `strlen(s, <half>)`, which then refuses at the read.
 *
 *  `gap` MAKES A GAP REFUSE. The count is contiguous, so an argument register with nothing reaching
 *  it ends it — and one is empty for two opposite reasons. Either the call really takes that few
 *  arguments, or the register still holds this function's own untouched incoming argument, a value
 *  the machine passes on that SSA has no definition for because nothing ever wrote it. When a
 *  LATER argument register does hold a value the second reading is the only one left, and taking
 *  the first drops that argument and every one after it: `ac-decomp:evw_anime_colreg_manual` sets
 *  up seven registers for `evw_color_set` and, with r4 at its incoming value, lifts to
 *  `evw_color_set(a0);` — its divide, its multiply and five arguments gone. Which reading it is
 *  cannot be decided from the register file alone — the function's own arity is exactly what is
 *  missing — so this refuses and names the gap rather than guessing, unless `decide` answers it:
 *  the lowering may show that the register above the gap is surely an argument, and where argument
 *  words fill in order the gap below it is then this function's own arguments passed on
 *  (frontend/call-plan.ts `decideGap`). A declaration answers it outright, and this scan is never
 *  weighed against one: it is a guess, and a guess that cannot fail cannot witness a width a
 *  declaration left open. */
export function fallbackArgc(
  ssa: { hasReachingDef(reg: string, b: number, accept?: (v: Value) => boolean): boolean },
  argRegs: readonly string[],
  bi: number,
  opts: {
    /** whether `v`, reaching argument register `reg`, is a value the caller may have set up */
    accept?: (v: Value, reg: string) => boolean;
    /** the call's function, where it is (`CallSite`'s `guess.at`), and the frontend's own refusal */
    gap: { name: string; at: number | string; fail: FrontendRefusal };
    /** the leading arguments a declaration states (`GuessedCallSite.floor`): counted whether or not
     *  the caller set them up, so only the registers above them are guessed */
    floor?: number;
    /** whether argument register `reg` still holds this function's own incoming value at the call
     *  (an entry parameter, which a read leaves behind as a definition) on some path the caller
     *  did not set it up on: one a call destroyed it on ends there, and one this block wrote it on
     *  since its last call set it up (`CallDeclarations.lower` asks it) */
    entry?: (reg: string) => boolean;
    /** whether the gap `gap` — argument registers nothing reaches, in order — below `set`, the next
     *  one a value reaches, is decided: the frontend shows `set` holds an argument, so `gap` holds
     *  arguments passed on unchanged (`CallDeclarations.lower`'s `decideGap`). Handed the gap's
     *  refusal, owed should a proof it defers fail. Absent, or false, the gap refuses. It is asked
     *  again with an empty `gap` for every register the count takes past a decided gap. Each must be
     *  proven an argument the same way, or the gap refuses. */
    decide?: (gap: readonly string[], set: string, refuse: () => void) => boolean;
    /** whether what a jump-table dispatch parked in argument register `reg` reaches the call
     *  (`CallSite.parked`). Where nothing `accept` takes reaches it too, the count stops below it: no
     *  compiler hands a callee the dispatch's own register, so no register above it is an argument.
     *
     *  WHY THIS STOPS WHERE A CALL-DESTROYED REGISTER REFUSES (`r2 holds a value and r1 holds
     *  none`): where the value above came from. A call destroys every caller-saved register, so one
     *  holding a value after it was written since, for a call — an argument as likely as not. A
     *  dispatch clobbers only its idiom's registers, and agbcc moves a value it keeps live across the
     *  switch out of them, upward, before the idiom runs (`add r2,r1,#0` ahead of the `lsl` in a
     *  switch on r0 whose cases call): the value above the parked register was set up for the switch,
     *  not for the call. The cost is a value a case itself writes above the parked register, dropped
     *  too (`mov r2,#5; mov r0,#1; bl g` lifts `g(1)`): no compiler measured writes one there. A
     *  parked register a call in the case destroyed is that call's hole, not the dispatch's, and it
     *  stops the count only where no register above holds a value written since that call
     *  (`SsaBuilder.holdsValue`): `bl h; mov r2,#5; mov r0,#1; bl g` refuses, while `add r3,r1,#0`
     *  ahead of the idiom and `bl h; mov r0,#1; bl g` in a case lifts `g(1)` — the gap rule's
     *  `setUp` walks through calls and would count r3's copy, which `h` destroyed. */
    parked?: (reg: string) => boolean;
    /** how many argument words the callee's own body reads at most (frontend/callee-body.ts),
     *  asked only where it can answer something. It is an upper bound on what the callee READS, and
     *  a source call passes more than that whenever a parameter goes unused or a K&R call hands
     *  extra arguments — `setx(a + 1, 4)` to a body reading only its first, `rd1(a, b, 7)` to one
     *  reading r0 — so it never caps what the caller set up for the call: such a register stays
     *  counted, and a value above a gap still decides the gap below it (`decide`). It answers only
     *  for registers at or past it, whose being arguments changes nothing the callee computes:
     *    - one that is a `leftover` stops the count: a write something else read since, which the
     *      call found there (`gH = 5; gA = rnd()` leaves the store's 5 in r0, which the guess took as
     *      `rnd(5)`). A copy made for the call is none, whatever read its value before
     *      (`g4(a, b, c, d); un(a, b, c, d)` copies a..d back from their homes for `un`);
     *    - a gap starting there, under a register that is a leftover or that no proof makes an
     *      argument, stops the count at the gap rather than refuse.
     *  A gap BELOW the bound refuses as ever, whatever lies above it: the callee may read it, and it
     *  holds this function's own incoming value or nothing. `gp = 3; gq = rd1(a)` leaves the store's 3
     *  in r1 above r0's a, and stopping there would drop the `a` rd1 reads. */
    bound?: () => number | undefined;
    /** whether what reaches argument register `reg` was written for something other than the call,
     *  which read it since, and left there (frontend/call-plan.ts `leftover`). Asked only at or past
     *  `bound`. */
    leftover?: (reg: string) => boolean;
  },
): number {
  const accept = opts.accept ?? (() => true);
  // whether the caller set argument register k up: a definition reaches it, through a call too
  const setUp = (k: number) => ssa.hasReachingDef(argRegs[k], bi, (v) => accept(v, argRegs[k]));
  const { name, at, fail } = opts.gap;
  const call = typeof at === 'number' ? `at 0x${at.toString(16)}` : at;
  const floor = opts.floor ?? 0;
  // the registers past the lowest parked one are none of the call's: neither counted nor a gap's top
  const parkedAt = argRegs.findIndex((r, k) => k >= floor && opts.parked?.(r) === true && !setUp(k));
  const top = parkedAt < 0 ? argRegs.length : parkedAt;
  // the run of argument registers the caller set up from `from`, each past a declaration's
  // stated words asked whether it still holds the incoming value
  // whether argument register `k` lies at or past what the callee's own body reads
  const unread = (k: number): boolean => {
    const b = opts.bound?.();
    return b !== undefined && k >= b;
  };
  // past the bound, a leftover is no argument (`bound`): leftover first, the cheaper question
  const notPassed = (k: number): boolean => opts.leftover?.(argRegs[k]) === true && unread(k);
  const run = (from: number): number => {
    let n = from;
    while (n < top && setUp(n) && !notPassed(n)) {
      // PAST A DECLARATION'S STATED WORDS, A REGISTER STILL HOLDING ITS INCOMING VALUE REFUSES. A
      // read of it (a home store, a compare, a store to a global) leaves the entry parameter behind
      // as a definition, so it reads as set up, and it is exactly as undecidable as the gap below: the
      // function's own argument passed on, or one the call is not handed. Counted, it is an argument
      // the source never passed — `int logv(const char *, int, ...)` and `logv(s, c) + 1` in a
      // function whose unused third parameter IDO home-stores lifts `logv(a0, a1, a2)`. Below a
      // floor the scan never asks, and with none the guess keeps counting it: there it is the far
      // commoner `if (a) g(a)`, and the same refusal declines 17 lifts of kleod's 20 units and 40 of
      // sa3's (`DecompressAlloc(a0)`, `m4aSongNumStart(a1)`), where the floored rule moves none.
      //
      // ONLY A PATH THE ENTRY VALUE STILL ARRIVES BY IS ASKED. `setUp` walks through calls, so an
      // entry value a call destroyed reaches it too — `g(x); dprint(s)` — and that register holds
      // nothing; the trim cuts it (`trimClobberedCallArgs`) and `dprint(a0)` is the bytes. And a
      // register this block wrote since its last call was set up here, by the copy that put the
      // value back — `g(y); dprint(s, x)` re-sets r1 from a saved copy — whatever value SSA names.
      if (floor > 0 && opts.entry?.(argRegs[n])) {
        fail(
          `cannot lift '${name}': the call ${call} has a prototype stating only its first ${floor} ` +
            `argument${floor === 1 ? '' : 's'}, and ${argRegs[n]} past them still holds this function's own incoming ` +
            'value — an argument passed on unchanged and one the call is not handed look the same here, so the ' +
            'argument count is not decidable',
        );
      }
      n++;
    }
    return n;
  };
  // where the run stopped at a register set up but no argument (`bound`), every one above is past
  // the bound too, and the count ends there
  const stoppedPast = (n: number): boolean => n < top && setUp(n);
  let n = run(floor);
  if (stoppedPast(n)) {
    return n;
  }
  // A GAP BELOW A REGISTER THAT HOLDS A VALUE refuses, unless the frontend decides it: then the run
  // goes on through the gap and the register above it, and the next gap is asked the same.
  //
  // PAST A DECIDED GAP, EVERY REGISTER THE RUN COUNTS MUST BE PROVEN TOO (asked of `decide` with an
  // empty gap), or the gap refuses. The decision says the register above the gap is an argument and
  // nothing about the ones above that. Without the gap's refusal the run would count whatever reaches
  // them: a store's address or value, a discarded volatile read, a temp, an incoming value read
  // elsewhere. Measured 2026-10-18 at canonical flags: `gp[1] = 3; return g(a, -gy) + 1;` would
  // lift `g(a0, -gy, &gp)` on agbcc, `return g(a, c + 1) + 1;` `g(a0, a2 + 1, a2)` on all seven
  // toolchains, and `*(volatile int *)K; g(a, b, (short)c)` made agbcc's discarded read a fourth
  // argument.
  for (let k = n + 1; k < top; k++) {
    if (setUp(k)) {
      const [gapAt, setAt] = [n, k];
      const refuse = () =>
        fail(
          `cannot lift '${name}': the call ${call} ` +
            (opts.floor
              ? `has a prototype stating only its first ${opts.floor} argument${opts.floor === 1 ? '' : 's'}`
              : 'has no prototype') +
            `, ${argRegs[setAt]} holds a ` +
            `value and ${argRegs[gapAt]} holds none — an argument register left at its incoming value and one ` +
            `the call does not pass look the same here, so the argument count is not decidable`,
        );
      // the gap and the register above it are past what the callee reads: no argument it can tell
      // from a missing one, so the count stops below the gap as at a gapless call
      if (opts.leftover?.(argRegs[k]) === true && unread(gapAt)) {
        return gapAt;
      }
      if (!opts.decide?.(argRegs.slice(n, k), argRegs[k], refuse)) {
        if (unread(gapAt)) {
          return gapAt;
        }
        refuse();
      }
      n = run(k);
      const stopped = stoppedPast(n);
      for (let above = k + 1; above < n; above++) {
        if (!opts.decide?.([], argRegs[above], refuse)) {
          if (unread(above)) {
            return above;
          }
          refuse();
        }
      }
      if (stopped) {
        return n;
      }
      k = n;
    }
  }
  return n;
}

/** One call site whose arity was GUESSED by {@link fallbackArgc}, with what the lifting scan saw
 *  of its own block up to that instruction. */
export interface GuessedCallSite {
  block: number;
  /** the `call` op — its arguments (`callArgs`) are the guessed ones, in argument-register order */
  op: Op;
  /** argument registers written between the last call in this block (or the block's start) and here */
  freshBefore: Set<string>;
  /** did this block already make a call before this one? */
  afterCallInBlock: boolean;
  /** what this block did to the return register before this call: a call here left it holding
   *  nothing (`destroyed`), the block wrote it since (`written`), or neither, so the predecessors
   *  decide (`inherited`) */
  returnRegBefore: 'destroyed' | 'written' | 'inherited';
  /** which earlier callee's result in the return register is an argument here, not a leftover:
   *  the site's lowering says so (`SsaBuilder.recordGuessedCall` (frontend/ssa.ts)). Absent where none is. */
  passesCalleeResult?: (result: Value) => boolean;
  /** handed the FRESH argument registers the trim cuts from this site's guess, and the ones it
   *  keeps — the lowering's `CallSite.leftOut` question, asked again where the arity shrinks a
   *  second time. An unfresh cut is the trim's own proof; a fresh one went with a hole below it
   *  (see {@link trimClobberedCallArgs}), which proves nothing. The `/setup-args` reading asks it a
   *  third time, of the cut registers the call's own block wrote (of every one it cuts, where
   *  `asksEveryCut`), and a refusal there withholds that reading for the site instead of declining.
   *  Absent where nothing is asked. */
  trimmed?: (cut: readonly string[], kept: readonly string[]) => void;
  /** whether the frontend withholds the `/setup-args` reading from this site whatever it would cut
   *  (`CallSite.withholdsSetupArgs`). Absent where it does not. */
  withholdsSetupArgs?: () => boolean;
  /** whether the `/setup-args` reading of this site asks `trimmed` of every register it cuts, an
   *  earlier block's leftovers included ({@link narrowingKeepsFrameAddresses};
   *  `CallSite.asksEveryCut`). Absent where it asks only of what the call's own block wrote. */
  asksEveryCut?: () => boolean;
  /** how many leading arguments a declaration STATES, so neither reading cuts below them: the
   *  fixed parameters of a variadic declaration that are each one word (frontend/call-plan.ts
   *  `variadicFloor`). Only the arguments past them are guessed. Absent where none is stated. */
  floor?: number;
}

export interface CallArgTrim {
  /** the function being lifted, for a refusal */
  name: string;
  argRegs: string[];
  /** the ABI return register. Load-bearing only where it IS `argRegs[0]` (ARM r0, PPC r3) — that
   *  aliasing is what makes a callee's result indistinguishable from caller-side argument setup. */
  returnReg: string;
  /** every value a `call` op produced. Tells a callee's own return apart from a join that merely
   *  PASSES THROUGH one, which the register file cannot: both leave argument 0 unfresh. */
  calleeResults: ReadonlySet<Value>;
  /** per block, the registers a call destroyed on SOME path into it with nothing written since. A
   *  call lists the return register there only when it leaves it holding nothing the caller can
   *  name — a struct handed back in it (`SsaBuilder.noteCall` (frontend/ssa.ts)). */
  destroyedIn: ReadonlyArray<ReadonlySet<string>>;
  /** one entry per CFG edge, as passed to `makeSsaBuilder` (frontend/ssa.ts) */
  preds: number[][];
  /** the blocks `preds` indexes, terminators included — the edges a guard proves a value on */
  blocks: readonly Block[];
  /** per block: the keys written since its LAST call (since its start if it makes none). Indexed by
   *  block, and it holds every key the builder saw, not only argument registers. */
  freshAtEnd: Array<Set<string>>;
  /** blocks that make at least one call */
  callsIn: Set<number>;
  sites: GuessedCallSite[];
}

/** Cut a GUESSED call arity down by the ABI's caller-saved clobber.
 *
 *  `fallbackArgc` counts argument registers that merely have a reaching definition. A call clobbers
 *  r0..r3, so a definition the call sits between cannot be an argument the caller set up — correct
 *  compiled code would have re-materialized it. Counting it anyway INVENTS arguments
 *  (`m4aSongNumStart(0x89, 30, x, &g)` for a one-argument callee) — a hard compile error where the
 *  project's own header is in scope, and silently wrong code where C89's implicit declaration
 *  covers for it.
 *
 *  SCOPE: this closes the arguments an intervening CALL disproves, which is the common case in real
 *  code. It does not close the rest — a dead value the compiler happened to leave in the next
 *  argument register with no call in between still reads as an argument, and nothing about the
 *  register file can say otherwise. A declared prototype closes those outright; short of one, the
 *  narrower reading is recorded here and offered as a ranked candidate ({@link narrowToSetupArgs}).
 *
 *  A must-analysis: a register is FRESH at a point iff on EVERY path reaching it, it was written
 *  after the last call. The entry block starts all-fresh (those are the caller's own arguments).
 *  The result only ever SHRINKS an arity, but two of the shrinks are REFUSALS and not proofs, so a
 *  real argument CAN go with them: a fresh register above a hole stops the run (a 64-bit return
 *  occupies two registers and the frontend cannot express one, so the caller's r2 goes with the
 *  unfillable r1), and a callee's return read as the callee's own drops an argument a `g(f())`
 *  source did pass. A declared prototype is what closes either for a named callee; a call through a
 *  register has none, so it keeps that return instead (`GuessedCallSite.passesCalleeResult`).
 *
 *  Frontend-agnostic: the caller supplies what its own lifting scan observed, so nothing here
 *  re-derives which instruction writes which register. */
export function trimClobberedCallArgs(inp: CallArgTrim): void {
  const { argRegs, returnReg, calleeResults, destroyedIn, preds, blocks, freshAtEnd, callsIn, sites } = inp;
  const blockCount = freshAtEnd.length;
  const all = () => new Set(argRegs);
  const localEnd = (b: number) => freshAtEnd[b] ?? new Set<string>();
  // freshOut[b]: registers fresh where b ends. A block that calls forgets everything before its
  // last call; one that does not passes its input through, plus what it wrote.
  const freshOut: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const freshIn: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const inOf = (b: number): Set<string> => {
    // A block with NO predecessors is the function entry (or unreachable): its argument registers
    // are the ones the caller set up. An entry that DOES have predecessors — an entry that is also
    // a loop header — gets the ordinary intersection instead, because on the back edge the caller's
    // setup is long gone and an intervening call may have clobbered it.
    const ps = [...new Set(preds[b] ?? [])];
    if (ps.length === 0) {
      return all();
    }
    const acc = new Set(freshOut[ps[0]]);
    for (const p of ps.slice(1)) {
      for (const r of [...acc]) {
        if (!freshOut[p].has(r)) {
          acc.delete(r);
        }
      }
    }
    return acc;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let b = 0; b < blockCount; b++) {
      const fin = inOf(b);
      const fout = callsIn.has(b) ? localEnd(b) : new Set([...fin, ...localEnd(b)]);
      if (fout.size !== freshOut[b].size || [...fout].some((r) => !freshOut[b].has(r))) {
        changed = true;
      }
      freshIn[b] = fin;
      freshOut[b] = fout;
    }
  }
  const runOfFresh = (fresh: Set<string>, from: number): number => {
    let n = from;
    while (n < argRegs.length && fresh.has(argRegs[n])) {
      n++;
    }
    return n;
  };
  // A LATER argument register this caller set up proves the call takes arguments at all, and
  // argument 0 sits below one that is proven — so it is being passed too, whatever put it there
  // (`bl __mulsf3; add r1,r4,#0; bl __addsf3` is `__addsf3(__mulsf3(a, b), c)`).
  const setsUpLater = (fresh: Set<string>): boolean => argRegs.some((r, i) => i > 0 && fresh.has(r));
  // THE RETURN REGISTER IS NOT ARGUMENT SETUP. Where the ABI aliases it onto argument 0, the
  // call lowering records a call's clobber AFTER its own result, so the result leaves the register
  // UNfresh here. That disproves caller setup only where the callee's return is BOTH what the
  // register still holds and all the site has to go on: with a later register set up (above), or
  // with a value no call produced — a join of one path's return with another path's caller-computed
  // value — argument 0 is a real argument, and dropping the second kind would delete the
  // instructions that computed it.
  //
  // With neither, the site carries no argument evidence at all: `bl f; bl g` is `f(); g();` as
  // readily as `g(f())`, the two spell the same bytes on this ABI, and only the nested one needs
  // `f` to return a value and `g` to accept one — a spelling the project's own header rejects
  // outright when it does not. A declared prototype never reaches here, and stays the way `g(f())`
  // is recovered.
  //
  // A SITE THAT PASSES THE RESULT ON keeps it (`GuessedCallSite.passesCalleeResult`).
  //
  // THE EXEMPTION NEEDS A RESULT IN THE REGISTER. A call that hands a struct back in it (`struct W1
  // mkw(s32)`) writes no value there — its bytes are a struct, not a word — so the register still
  // names what it held BEFORE that call, and neither clause above can tell: that value is no callee
  // result, which is the join clause's sign of a real argument. Destroyed on any path is no setup on
  // that path, so the register is an ordinary unfresh one there, and the run stops below it —
  // unless a later register is set up, which puts argument 0 below a proven one: that argument is
  // then the struct itself (`other(mv(a), b)`), a value no register here names, and it declines.
  //
  // WHETHER AN EDGE PROVES `v` CONSTANT EVERYWHERE `b` IS REACHED: up the chain of blocks with one
  // predecessor, a conditional branch on `v == K` arriving by its true edge, or on `v != K` by its
  // false one. K is any value arithmetic builds out of literals: agbcc compares with 1000 as
  // `mov r1,#250; lsl r1,#2; cmp r0,r1`. `v` holds every name the value goes by: compared past a join
  // the trivial-phi pass has yet to fold, a callee's result is that join's parameter.
  let defs: Map<Value, Op> | undefined;
  const defOf = (v: Value): Op | undefined => {
    defs ??= new Map(blocks.flatMap((blk) => blk.ops.flatMap((op) => op.results.map((r) => [r, op] as const))));
    return defs.get(v);
  };
  const isLiteral = (v: Value): boolean => {
    const d = defOf(v);
    return (
      d?.opcode === 'const' ||
      (d !== undefined && LITERAL_ARITHMETIC.has(d.opcode) && d.operands.length > 0 && d.operands.every(isLiteral))
    );
  };
  const provenConstant = (v: ReadonlySet<Value>, b: number): boolean => {
    for (let at = b, seen = new Set<number>(); !seen.has(at);) {
      seen.add(at);
      const ps = [...new Set(preds[at] ?? [])];
      if (ps.length !== 1) {
        return false;
      }
      const term = terminator(blocks[ps[0]]);
      const arrives = term?.successors.map((e) => e.block === blocks[at]) ?? [];
      const cmp = term?.opcode === 'cond_br' && arrives[0] !== arrives[1] ? defOf(term.operands[0]) : undefined;
      const equalEdge = cmp?.opcode === 'icmp_eq' ? 0 : cmp?.opcode === 'icmp_ne' ? 1 : -1;
      if (
        equalEdge >= 0 &&
        arrives[equalEdge] &&
        cmp!.operands.some((o) => v.has(o)) &&
        cmp!.operands.some((o) => !v.has(o) && isLiteral(o))
      ) {
        return true;
      }
      at = ps[0];
    }
    return false;
  };
  // THE RESULT A SITE PASSES ON is looked for through the joins the trivial-phi pass has yet to
  // fold: this trim runs before it, so a result r0 carries untouched across a loop reaches the call
  // as the loop header's parameter, not as the callee's own value. The site passes one where every
  // path brings it an earlier callee's result it passes (`GuessedCallSite.passesCalleeResult`) —
  // that value, or the join itself where the paths bring different ones (`v = x ? g() : h(); p(v);`).
  let joinArgs: Map<Value, Value[]> | undefined;
  const joinedInto = (v: Value): Value[] | undefined => {
    if (joinArgs === undefined) {
      joinArgs = new Map();
      for (const blk of blocks) {
        for (const op of blk.ops) {
          for (const e of op.successors) {
            // the entry block's parameters are the function's own, whatever a back edge brings
            if (e.block === blocks[0]) {
              continue;
            }
            e.block.params.forEach((param, i) => {
              const into = joinArgs!.get(param);
              if (into) {
                into.push(e.args[i]);
              } else {
                joinArgs!.set(param, [e.args[i]]);
              }
            });
          }
        }
      }
    }
    return joinArgs.get(v);
  };
  const passedResult = (s: GuessedCallSite): Value | undefined => {
    const arg = callArgs(s.op)[0];
    const passes = s.passesCalleeResult;
    if (arg === undefined || passes === undefined) {
      return undefined;
    }
    const results = new Set<Value>();
    const seen = new Set<Value>();
    for (const work = [arg]; work.length > 0;) {
      const v = work.pop()!;
      if (seen.has(v)) {
        continue;
      }
      seen.add(v);
      const into = joinedInto(v);
      if (into !== undefined) {
        work.push(...into);
      } else if (calleeResults.has(v) && passes(v)) {
        results.add(v);
      } else {
        return undefined;
      }
    }
    return results.size === 0 ? undefined : results.size === 1 ? [...results][0] : arg;
  };
  const argcAt = (s: GuessedCallSite, fresh: Set<string>): number => {
    const destroyed =
      s.returnRegBefore === 'destroyed' || (s.returnRegBefore === 'inherited' && destroyedIn[s.block].has(returnReg));
    if (argRegs[0] === returnReg && !fresh.has(argRegs[0]) && destroyed && setsUpLater(fresh)) {
      const callee = s.op.attrs.target;
      throw new FrontendUnsupportedError(
        `cannot lift '${inp.name}': argument 1 of the call to ${typeof callee === 'string' ? `'${callee}'` : 'a callee'} ` +
          `is a struct an earlier call handed back in ${returnReg}, and nothing here passes one on as an argument — not modelled`,
      );
    }
    if (argRegs[0] !== returnReg || fresh.has(argRegs[0]) || destroyed) {
      return runOfFresh(fresh, 0);
    }
    const op = s.op;
    if (setsUpLater(fresh) || !calleeResults.has(callArgs(op)[0]) || passedResult(s) !== undefined) {
      return runOfFresh(new Set([argRegs[0], ...fresh]), 0);
    }
    return 0;
  };
  for (const s of sites) {
    const fresh = s.afterCallInBlock ? s.freshBefore : new Set([...freshIn[s.block], ...s.freshBefore]);
    const n = Math.max(s.floor ?? 0, argcAt(s, fresh));
    if (n < callArgs(s.op).length) {
      // only the FRESH ones: an unfresh register is the trim's proof (a path reaches here with
      // nothing set up in it since a call), a fresh one went with a hole below it
      s.trimmed?.(
        argRegs.slice(n, callArgs(s.op).length).filter((r) => fresh.has(r)),
        argRegs.slice(0, n),
      );
      truncateCallArgs(s.op, n);
    }
    // The SHORTER arity the same evidence also allows, recorded for {@link narrowToSetupArgs}: the
    // run over what THIS BLOCK wrote, dropping the registers that are fresh only because no call
    // stands between here and wherever they were last written. Both readings stay live, so this one
    // is recorded rather than applied. A survivor is what it drops, so the join clause above has no
    // place here — but `setsUpLater` still does: a register this block set up two instructions
    // before the call is not something the narrower reading may call dead.
    //
    // A SITE THAT PASSES AN EARLIER CALLEE'S RESULT ON keeps it in this reading too, except where an
    // edge proves that result equal to a constant on the way here (`if (g() == 0) p();`): a source
    // that passed it there makes the compiler load the constant it proved (`mov r0,#0`), so an asm
    // with no such load passed nothing. Per site, because this reading cuts every site at once, and a
    // drop that one site needs would otherwise drop a value another site passes.
    const result = n > 0 ? passedResult(s) : undefined;
    const passed = result !== undefined;
    const dropsPassed = passed && provenConstant(new Set([result, callArgs(s.op)[0]]), s.block);
    const localFresh =
      setsUpLater(s.freshBefore) || (passed && !dropsPassed) ? new Set([argRegs[0], ...s.freshBefore]) : s.freshBefore;
    const local = Math.min(Math.max(s.floor ?? 0, runOfFresh(localFresh, 0)), callArgs(s.op).length);
    if (
      local < callArgs(s.op).length &&
      s.withholdsSetupArgs?.() !== true &&
      narrowingKeepsFrameAddresses(s, argRegs, local)
    ) {
      setupArgc.set(s.op, local);
      if (local === 0 && dropsPassed) {
        discardsPassedResult.add(s.op);
      }
    }
  }
}

/** Whether the narrower reading of `s` ({@link narrowToSetupArgs}, cutting it to `local` arguments)
 *  passes the lowering's `CallSite.leftOut` question too (`GuessedCallSite.trimmed`). That reading
 *  is applied in the ranker AFTER the lift and its frame audit, so nothing downstream re-asks it: a
 *  register it cuts can hold a frame address set up in the call's own block (`mov r2, sp`) above an
 *  argument that came from an earlier one, and the cut lifts `g(a, b, s)` as `g(a)`, leaving the
 *  stores to `s` dead.
 *
 *  ONLY WHAT THE CALL'S OWN BLOCK WROTE is asked (`freshBefore`). That a value an earlier block left
 *  in a register is dead is this reading's whole guess, and a frame address is no exception: agbcc
 *  keeps `mov r3, sp` as a store base across blocks and calls `TransformSprite(s, t)` with it still
 *  in r3 (sa3 sub_805DADC), where the cut is the right arity. A register this block wrote is not
 *  that guess — the block set it up for the call — so where it may hold a frame address the call
 *  passes, the cut would drop an argument. A refusal withholds this candidate for this site only;
 *  the default reading stands. A leftover the guess was wrong about is caught of the lifted IR
 *  instead, where the cut leaves the object it addresses unread ({@link cutsUnreadFrameObjects}).
 *
 *  …AND EVERY REGISTER IT CUTS where the frontend says so (`GuessedCallSite.asksEveryCut`): a
 *  function whose frame verdict reads every argument register a call holds as possibly handed
 *  over, where a frame address an earlier block left is not the dead base this reading guesses at,
 *  and the IR question cannot settle it when the object is read elsewhere too
 *  (`if (a) h(b, a, t); else *q = t[0];` with `&t` left in r2). The question refuses only frame
 *  addresses, so a call that cuts none still narrows. */
function narrowingKeepsFrameAddresses(s: GuessedCallSite, argRegs: readonly string[], local: number): boolean {
  const every = s.asksEveryCut?.() === true;
  const cut = argRegs.slice(local, callArgs(s.op).length).filter((r) => every || s.freshBefore.has(r));
  if (s.trimmed === undefined || cut.length === 0) {
    return true;
  }
  try {
    s.trimmed(cut, argRegs.slice(0, local));
    return true;
  } catch (e) {
    if (e instanceof FrontendUnsupportedError) {
      return false;
    }
    throw e;
  }
}

/** The opcodes whose result is a literal when every operand is one ({@link trimClobberedCallArgs}). */
const LITERAL_ARITHMETIC: ReadonlySet<string> = new Set([
  'add',
  'sub',
  'mul',
  'and',
  'or',
  'xor',
  'shl',
  'shr_u',
  'shr_s',
  'not',
  'neg',
]);

/** The narrower arity {@link narrowToSetupArgs} would cut each guessed call to. A SIDE table and
 *  not an attr: this is a fact about one LIFT, not part of the IR the rest of the pipeline compares
 *  and prints — `structure/hazards.ts` decides two ops equal by comparing their attrs verbatim, so
 *  an attr only one of an otherwise-matching pair carries would cost a recovery. */
const setupArgc = new WeakMap<Op, number>();

/** The calls whose narrower arity drops an earlier callee's result that the site passes on
 *  (`GuessedCallSite.passesCalleeResult`): only where an edge proves that result constant on the way
 *  to the call ({@link trimClobberedCallArgs}). Read by {@link setupArgsDiscardsPassedResult}. */
const discardsPassedResult = new WeakSet<Op>();

/** Whether {@link narrowToSetupArgs} drops, somewhere in `fn`, an earlier callee's result that a
 *  call through a register is passed — the fact that makes the narrowed lift's candidates lose a
 *  score tie (`Candidate.discardsPassedResult`). */
export function setupArgsDiscardsPassedResult(fn: Fn): boolean {
  return fn.blocks.some((b) => b.ops.some((op) => discardsPassedResult.has(op)));
}

/** Whether anything in `fn` HAS the narrower reading — the variation's gate, so the ~99% of functions
 *  with no narrowable call cost no re-lift. Read it off the lift itself: a later pipeline stage may
 *  replace a `call` op (softdiv rewrites one to a division), and the table is keyed by op. A call
 *  {@link cutsUnreadFrameObjects} withholds has none. */
export function hasSetupArgsNarrowing(fn: Fn): boolean {
  if (!fn.blocks.some((b) => b.ops.some((op) => setupArgc.has(op)))) {
    return false;
  }
  const withheld = cutsUnreadFrameObjects(fn);
  return fn.blocks.some((b) => b.ops.some((op) => setupArgc.has(op) && !withheld.has(op)));
}

/** A frame address in the lifted IR: a `laddr`'s offset plus the constants added to it. `exact` is
 *  false once a term that is not a constant was added (`&buf[i]`), and `off` is then the address
 *  that term was added to. `end` is where the `laddr`'s storage ends. */
interface FrameAddress {
  readonly off: number;
  readonly exact: boolean;
  readonly end: number;
}

/** The calls whose `/setup-args` reading cuts the address of a frame object nothing else in `fn`
 *  reads, under that reading — which is then withheld for that call, the default reading standing.
 *
 *  THE QUESTION THE IR CAN ANSWER of a frame address an earlier block left in a register the reading
 *  cuts. That such a leftover is dead is the reading's whole guess, and agbcc does leave a dead
 *  `mov r3, sp` store base in a call's argument registers (sa3 sub_805DADC, which reloads the
 *  object after the call). Where the leftover was an argument after all, cutting it leaves the
 *  object's stores with no reader: `if (a) g(b, s)` with `s` left in r1 by the entry block lifts as
 *  `g(a1)` beside `s[0] = a0; s[1] = a1;`, which nothing reads. A source that compiled to those stores
 *  read the object somewhere, so a cut that leaves it unread drops an argument. The register file
 *  cannot tell the two leftovers apart; the object's readers can.
 *
 *  A READER is any use of an address into the object but the address operand of a store into it
 *  and an argument the narrower reading cuts — a load, an address stored or returned or carried
 *  to another block, an argument some call still passes. The other calls are read under the same
 *  narrowing, since the ranker applies it to every call at once.
 *
 *  THE OBJECT is the span between the offsets the function forms addresses at or accesses. Where the
 *  frame audit sized one `laddr` over two source objects (an escaped `sp+k`, which excuses every word
 *  from k up), the address the compiler formed for the second one (`add r2, sp, #0xc`) is where it
 *  starts: `int s[3]; char t[16]; ... if (a) g(b, s, t)` cut to `g(a1, sp0)` leaves `t` unread
 *  though `sp0` is passed. An access's offset counts as well, because the lift folds a formed
 *  `add r4, sp, #8` into the offsets of the loads and stores through r4, so the `laddr` they share
 *  no longer says where the second object starts. Splitting finer only withholds more. A load or
 *  argument at an offset reads the span it falls in. An address with a term that is not a constant
 *  reads its base's span: an index stays inside the object its base addresses.
 *
 *  NOT ANSWERED HERE: a cut whose object is read elsewhere too. That leftover cannot be told from the
 *  sub_805DADC dead base, by the IR or by the register file, so it narrows, except where the frontend
 *  withholds the reading at that call (`GuessedCallSite.withholdsSetupArgs`) or asks the register
 *  question of every cut there (`GuessedCallSite.asksEveryCut`). */
function cutsUnreadFrameObjects(fn: Fn): Set<Op> {
  const def = defOpMap(fn);
  const memo = new Map<Value, FrameAddress | null>();
  const frameAddress = (v: Value): FrameAddress | null => {
    if (memo.has(v)) {
      return memo.get(v)!;
    }
    memo.set(v, null); // a cycle through a phi's operands is no frame address
    const d = def.get(v);
    let r: FrameAddress | null = null;
    if (d?.opcode === 'laddr') {
      const off = d.attrs.off as number;
      r = { off, exact: true, end: off + (d.attrs.width as number) * (d.attrs.count as number) };
    } else if ((d?.opcode === 'add' || d?.opcode === 'sub') && d.operands.length === 2) {
      const konst = (x: Value): number | undefined => {
        const k = def.get(x);
        return k?.opcode === 'const' && typeof k.attrs.value === 'number' ? k.attrs.value : undefined;
      };
      const [x, y] = d.operands;
      const fx = frameAddress(x);
      const fy = d.opcode === 'add' ? frameAddress(y) : null; // `k - &s` is no address
      const base = fx === null ? fy : fy === null ? fx : null;
      if (base !== null) {
        const k = konst(fx === null ? x : y);
        r =
          k === undefined || !base.exact
            ? { ...base, exact: false }
            : { ...base, off: d.opcode === 'add' ? base.off + k : base.off - k };
      }
    }
    memo.set(v, r);
    return r;
  };
  const bounds = new Set<number>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        frameAddress(r);
      }
      const at = op.opcode === 'load' || op.opcode === 'store' ? frameAddress(op.operands[0]) : null;
      if (at?.exact) {
        bounds.add(at.off + (op.attrs.off as number)); // an access's offset (see THE OBJECT)
      }
    }
  }
  for (const a of memo.values()) {
    if (a !== null) {
      bounds.add(a.end);
      if (a.exact) {
        bounds.add(a.off);
      }
    }
  }
  const sorted = [...bounds].sort((x, y) => x - y);
  /** the span an access at `a` (plus `extra` bytes) reads — see THE OBJECT above */
  const span = (a: FrameAddress, extra = 0): [number, number] => {
    const at = a.off + extra;
    const lo = sorted.filter((x) => x <= at).pop() ?? at;
    const hi = sorted.find((x) => x > at) ?? a.end;
    return [lo, Math.max(hi, lo + 1)];
  };
  const reads: [number, number][] = [];
  const cuts = new Map<Op, [number, number][]>();
  const read = (v: Value, extra = 0): void => {
    const a = frameAddress(v);
    if (a !== null) {
      reads.push(span(a, extra));
    }
  };
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if ((op.opcode === 'add' || op.opcode === 'sub') && frameAddress(op.results[0]) !== null) {
        continue; // a derivation: its result's uses are the ones that read
      }
      const args = op.opcode === 'call' ? callArgs(op) : [];
      const keep = setupArgc.get(op) ?? args.length;
      op.operands.forEach((v, i) => {
        if ((op.opcode === 'store' || op.opcode === 'astore') && i === 0) {
          return;
        }
        if (op.opcode === 'call' && i >= keep && i < args.length) {
          const a = frameAddress(v);
          if (a !== null) {
            cuts.set(op, [...(cuts.get(op) ?? []), span(a)]);
          }
          return;
        }
        read(v, op.opcode === 'load' && i === 0 ? (op.attrs.off as number) : 0);
      });
      for (const s of op.successors) {
        s.args.forEach((v) => read(v));
      }
    }
  }
  const withheld = new Set<Op>();
  for (const [op, spans] of cuts) {
    if (spans.some(([lo, hi]) => !reads.some(([rlo, rhi]) => rlo < hi && rhi > lo))) {
      withheld.add(op);
    }
  }
  return withheld;
}

/** Cut every guessed call to the arity its OWN BLOCK set up, and report whether anything moved.
 *
 *  `trimClobberedCallArgs` keeps an argument register whose value merely survives from an earlier
 *  block, because compiled code really does pass one that way: agbcc leaves a value already in r0
 *  where it is and branches to the call (`if (x) f(x);` is `cmp r0,#0; beq; bl f`, no setup at
 *  all). Those are also the bytes `if (x) f();` compiles to, so usually neither reading is
 *  refutable — but where the guard is an EQUALITY the compiler proves the argument constant and
 *  has to materialize it (`if (x == 0) f(x);` opens the arm with `mov r0,#0`), and the absence of
 *  that instruction rules the wider reading out. Which case a function is in is not knowable from
 *  the register file, and is exactly what a differ decides. Hence a ranked candidate rather than a
 *  default: the arm that passes only what the calling block itself put there.
 *
 *  Applies only to arities that were GUESSED — a declared prototype never recorded the fact. */
export function narrowToSetupArgs(fn: Fn): boolean {
  let changed = false;
  const withheld = cutsUnreadFrameObjects(fn);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (withheld.has(op)) {
        setupArgc.delete(op);
        discardsPassedResult.delete(op);
      }
      const setup = setupArgc.get(op);
      if (setup !== undefined && setup < callArgs(op).length) {
        truncateCallArgs(op, setup);
        changed = true;
      }
    }
  }
  if (changed) {
    // A dropped argument can be a join's last reader, and `finish()` pruned the dead phis before
    // this reading existed. Left in, the phi's edge args render as assignments to a local nothing
    // reads (`v0 = UpdateWorldMapCursor();`) — see the note on the prune in `finish`.
    pruneDeadParams(fn);
  }
  return changed;
}
