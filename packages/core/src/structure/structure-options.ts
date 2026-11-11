// asmlift structurer — what a caller hands `structure()`: the options threaded as data
// (`StructureOptions`), the test-only seams kept apart from them (`StructureHooks`), the join site
// the hooks report (`JoinPastReturnsSite`), and the declared-callee tables cut to what one body
// calls (`calledOnly`).
import { Block } from '../ir/core';
import type { IrType } from '../ir/types';
import { Stmt, walkExprs } from '../l3/ast';
import type { Gate } from '../l3/gates';
import type { ContextGlobals } from '../proto-context';
import type { SymbolInfo } from '../symbols';
import type { CarrierName, EnclosingCarrier, FreshMergeCarrier } from './carrier-gates';
import type { SinkCandidate } from './hazards';
import type { StaticLayout } from './local-statics';
import type {
  BreakTailCycle,
  BypassTailCandidate,
  ExitTailCandidate,
  ForBoundReading,
  ForPlanCandidate,
  ForPlanIv,
  OutwardExitCandidate,
  TwoLevelBreak,
  TwoLevelCandidate,
  TwoLevelRegion,
} from './loop-gates';
import type { NameMerge } from './namecoalesce';
import type { ArithCompilerFacts } from './pointer-spelling';
import type { SwitchBoundCase } from './switch-recover';

// Structuring options, threaded as DATA so a new one is a field here + its consumer, not a new
// positional boolean widened across every call site:
//   returnsVoid                    — from the function's own prototype (suppress phantom r0 return);
//   coalesceLoopInit               — keep the induction var in its arg register;
//   preserveDivergentBranchSense   — reproduce source branch direction on divergent ifs;
//   orderArgCopiesByWriteOrder     — order edge copies by the order the pred WROTE their
//                                    destinations.
// The last three are `compilerBehaviors` (target.ts) — this pass stays target-AGNOSTIC: it reads
// booleans, never a compiler name. So are the arithmetic table's (`ArithCompilerFacts`), which this
// type extends and hands to `makePointerSpelling` whole; the byte-pointer temp step below reads
// `keepsPointerSumAddend` from it too.
//
// WHAT A FIELD DOC BELOW HOLDS, narrowly: what the option MEANS to `structure()`, and the suffix of
// the variation that enumerates it. A VARIATION's rationale, and any figure pricing its marginal value, live
// ONCE at its `STRUCTURE_VARIATIONS` entry in rank-variations.ts — restated here the two copies rot
// separately, and only that one is the entry the enumeration reads. Figures pricing a
// DEFAULT this pass owns (the edge-copy ordering, `spellDeclaredSubscripts`) do belong here.
export interface StructureOptions extends ArithCompilerFacts {
  returnsVoid?: boolean;
  coalesceLoopInit?: boolean;
  preserveDivergentBranchSense?: boolean;
  // Spell a JOINED two-armed if with the negated condition and swapped arms: the asm branched
  // forward to the taken block and fell through to the other, so a compiler that preserves
  // source branch direction saw the FALL-THROUGH arm as `then` — the same layout evidence the
  // divergent case reads (preserveDivergentBranchSense), which post-dominance hides here because
  // both arms reconverge. Defaults to preserveDivergentBranchSense rather than to a constant, so a
  // target that opts out of the divergent claim opts out of this one; target.ts says how.
  //
  // This is the ZERO POINT of rank.ts's `/flip-join` variation, not a per-compiler fact that closes
  // the question — docs/level-tower.md wants a default only where the mapping is a FUNCTION, and
  // benchmark rows still reach their winning spelling through the variation rather than through this
  // default. Read it forward only: it says which sense to emit ABSENT evidence of an inversion,
  // never that the asm's layout WAS the source's sense. What agbcc contributes is the refusals —
  // its gcc Makefile SRCS compiles neither sched.c nor reorg.c and toplev.c never sets
  // flag_schedule_insns, and gcse.c runs one_code_hoisting_pass only `if (optimize_size)`, which
  // toplev.c sets for -Os alone — so no scheduler and no hoister moves an arm's body across the
  // branch after stmt.c laid the arms out in source order.
  //
  // Three mechanisms DO invert the sense, and each is per-SITE where this option is per-function,
  // so no value here is right in every `if` of a function that holds several: a short-circuit
  // fold picks which successor is `taken` from the asm's branch polarity, which on Thumb the
  // branch RANGE decides (raise/shortcircuit.ts); a relay past a branch's reach inverts to jump
  // around the long form; and a rotated loop's zero-trip guard is an `if` no source wrote at all
  // (`synthetic:fib`, `for(i=0;i<n;i++)`, emits `if (0 >= a0) … else do{…}while`), so there no
  // spelling is the faithful one and only the differ can choose. `senseFromFoldEvidence` below
  // answers the FIRST of the three per site, off the fold's own record.
  negateJoinedBranchSense?: boolean;
  /** Spell a branch-sense site from the SHORT-CIRCUIT FOLD'S own orientation evidence, where the
   *  fold left some, instead of from the two booleans above. `raise/shortcircuit.ts` stamps the
   *  fused branch with three facts: `scSharedOnFall` — whether the arm both tests reach was FALLEN
   *  INTO rather than branched to, and so, since gcc lays a condition's arms out in source order,
   *  whether it is the source's `then` — `scSharedIsTaken`, which successor slot that arm landed in
   *  here, and `scEdgeRelayed`, whether a long-branch trampoline sat on either edge, which is the
   *  layout where the source-order premise is inverted and therefore must not be consulted. The
   *  site NEGATES in one cell only: the shared arm in the TAKEN slot, branched to, no relay — the
   *  taken slot holding the source's `else`. Per SITE, which is the point: the booleans are per
   *  function, and a function whose `if`s were written in opposite senses has no right value for
   *  either.
   *
   *  A site the fold did not touch carries no stamp and keeps its boolean, so this changes nothing
   *  on a function with no short-circuit chain. rank.ts's `/site-sense` variation; it is a VARIATION and not
   *  a default because the source-order premise under `scSharedOnFall` is a claim about gcc's
   *  layout that the differ referees per row — and because one cell of the table is genuinely
   *  undecided by these three facts (see the census at the read). */
  senseFromFoldEvidence?: boolean;
  /** PER-SITE override of whatever decided a site's sense — the boolean, or `senseFromFoldEvidence`
   *  where that is on: the ORDINALS of the branch-sense sites to spell the OTHER way round. A
   *  site's ordinal is its
   *  position among the distinct blocks that turn out to BE sense sites, in first-visit order —
   *  a numbering only this pass can hand out, since a site exists only once structuring has
   *  decided both of its arms are real. Absent ⇒ the booleans alone decide, which is every caller
   *  but the enumerating one; an ordinal past the last site is inert. */
  branchSenseFlipSites?: ReadonlySet<number>;
  orderArgCopiesByWriteOrder?: boolean;
  /** Order a measured edge's ACYCLIC copy set by the def-position proxy instead — the
   *  `/copy-defpos` ranked sibling of the write-order spelling (rank.ts). A CYCLIC set keeps the
   *  record either way: there an instruction names the compiler's temp, and no arm of the fan may
   *  contradict it (`copySetIsCyclic`). Not a target field and deliberately not one: which order a
   *  compiler laid out is two-sided inside one compiler, so the differ referees it per row. Inert
   *  on an unmeasured pred, where the proxy is already what runs. */
  preferDefPosCopyOrder?: boolean;
  /** In a jump table where two or more arms enter one sibling arm's body (a cross-jumped tail),
   *  write that body back into EVERY entrant instead of letting the one the arm-order policy puts
   *  above the sibling keep its fall-through (`copySharedFallTargets`). rank.ts's `/tail-copies`
   *  variation: which arm the source wrote the tail under is not in the asm, and one compiler answers
   *  both ways, so the differ referees it. Inert where no switch has such a sibling. */
  copyEveryTailEntrant?: boolean;
  /** In a jump table where two or more arms enter one sibling CASE arm's body and the copies would
   *  write that body back into the entrants (`copySharedFallTargets`), spell them with the one
   *  fall-through and `goto`s to that case's label instead (`jumpSharedFallTargets`), the source's
   *  own spelling of the shape. rank.ts's `/case-goto` variation: a cross-jump of copies and a goto
   *  are one asm where the cross-jump merges the whole copy, and the copies are a goto-free reading
   *  that compiles elsewhere (agbcc's CSE stops the cross-jump short of a copy that re-reads an
   *  address the arm already formed), so the differ referees it. Inert where no switch has such a
   *  sibling. */
  jumpToSharedCases?: boolean;
  /** Spell EVERY `while (1)` loop `forPlanAt` accepts as `for (init; cond; inc)` on the first
   *  structuring, not only one a declined run asked for (`ForRanking`). rank.ts's `/for-continue`
   *  variation: a counted loop whose latch holds the update and the test is the same asm as
   *  `while (1)` with that latch at the foot of the body and as a `for` whose `continue` runs it, so
   *  the differ referees the two where both lift. Inert where `forPlanAt` refuses every loop. */
  spellCountedLoopsFor?: boolean;
  // Comparison-tree switch recovery: treat an `x != K` test as a case (the EQUAL side is a case
  // body). GCC freely uses `!=`; IDO prefers `==`/`<`. A compiler behavior, not an `arch ==`
  // branch — default true (permissive; the decline path keeps it sound either way).
  switchAllowsNeqCase?: boolean;
  // Comparison-tree switch recovery: treat a relational test as a case where the values that can
  // reach it leave exactly one on a side its compiler's dispatch lands a body on — the BRANCH
  // (`'taken'`) or either side (`'either'`). A compiler behavior declared in
  // TargetDescription.compilerBehaviors. Absent: every relational edge navigates.
  switchBoundCase?: SwitchBoundCase;
  // Comparison-tree switch recovery: emit the case arms in the order the ASSEMBLY lays their
  // bodies out, rather than sorted by ascending case value. A compiler behavior declared in
  // TargetDescription.compilerBehaviors — a compiler opts in on evidence that it neither reorders
  // basic blocks nor schedules across them, so the layout it produced IS the order the source
  // wrote. Default false: absent, the arms keep the ascending spelling.
  switchArmsFollowLayout?: boolean;
  // Comparison-tree switch recovery: DECLINE a tree whose own layout interleaves a test block with
  // a case body, on the reading that the source wrote an if/else-if LADDER there and not a
  // `switch`. Regime A otherwise recovers a `switch` from any comparison tree it can, so a ladder
  // and a `switch` over the same values produce the SAME candidate and the differ never sees the
  // ladder — there is nothing in the fan for it to prefer.
  //
  // The two spellings are different objects. Compiled at agbcc's canonical flags the same two-case
  // body is 20 bytes either way (0x14, ten Thumb instructions — the pair is committed as
  // `corpus/agbcc-sw{frontload,ladder}.s`) and disagrees instruction for instruction: the `switch` emits
  // `cmp #0x1e; beq` then `cmp #0x64; bne` — both tests ahead of both bodies, and sorted ASCENDING,
  // which is the reverse of the order the source writes them in — while the ladder emits
  // `cmp #0x64; bne` directly above its own body and reaches `cmp #0x1e` only after it.
  //
  // Read PER SITE off the recovery's own blocks — a function may hold one of each — and it
  // inherits `layoutIndex`'s frontend premise (see switch-recover.ts PRE5, which also states what
  // the gate costs when the premise fails: the `switch` spelling, never correctness — and what a
  // lost spelling actually looks like, which on a NESTED tree is an `if` nest around a `switch`
  // over some of the arms, not a clean ladder).
  // Default false: absent, every recoverable tree is still spelled as a `switch`.
  switchRequiresFrontLoadedTests?: boolean;
  // Does the TARGET LANGUAGE spell a `switch` arm that runs on into the next one? Set from the
  // caller's LanguageBackend (`spellsSwitchFallthrough`), not from the compiler target: it is a
  // property of what the emitted source may say, and the only reason the structurer needs it is
  // that a fall-through switch has a SECOND, behaviourally identical recovery. Regime A declines
  // to if-recovery when it is false; Regime B, having no fallback, fails loud. Default true.
  spellSwitchFallthrough?: boolean;
  // Does the TARGET LANGUAGE spell a `break` that leaves a `switch` arm before its end? Set from
  // the caller's LanguageBackend (`spellsSwitchBreak`), for the same reason as the line above. When
  // false, a CLOSED arm gets no region (`structureArm`), so `switchBreakAt` never mints the
  // statement and the arm structures to the CFG's joins, copying the tail its early exit skips into
  // each path. A FALLING arm needs no gate of its own: a language without a mid-arm `break` has no
  // fall-through either (Pascal), and `spellSwitchFallthrough` keeps those out. Default true.
  spellSwitchBreak?: boolean;
  // Which way this compiler hands out frame slots against DECLARATION RANK: `ascending` = the
  // earlier-declared spilled local takes the LOWER `[sp,#k]`. A compiler behavior declared
  // in TargetDescription.compilerBehaviors, carried to the backend on `SFn.slotOrder` and applied
  // by `l3/slotorder.ts` at emit time. ABSENT means the ordering refuses — there is no default
  // direction, because a wrong one reorders declarations for no reason.
  //
  // TWO STATES, NOT THREE. `TargetDescription` spells a third, `'unknown'`, and it earns its place
  // there: it separates a direction that was measured and deliberately not shipped from one nobody
  // ever asked about, which is a fact about the target worth writing down. Nobody reads a
  // STRUCTURER option to learn what was measured, so carrying it here would be a second way to
  // spell "no" on a public option type. The translation happens once, in `structureOptionsFor`
  // (target.ts), which is where the target-to-structurer mapping lives.
  spillSlotOrder?: 'ascending' | 'descending';
  // Each declared callee's parameter types, carried to the backend on `SFn.declaredArgs` (see
  // there). Built by `structureOptionsFor` from the prototype table.
  declaredArgs?: Readonly<Record<string, readonly (string | undefined)[]>>;
  // Each declared callee's return type, carried on `SFn.declaredReturns` the same way.
  declaredReturns?: Readonly<Record<string, string>>;
  // The emitted C is compiled as C++ (`SFn.dialect`).
  dialect?: 'c++';
  // The compiler parses a designated initializer element (`SFn.designators`; the compiler behavior
  // of the same name says which do).
  designatedInitializers?: boolean;
  // The compiler's C refuses C's implicit pointer conversions (`SFn.strictConversions`; the compiler
  // behavior `strictPointerConversions` says which does).
  strictPointerConversions?: boolean;
  // Commutative load pairs re-spell in def (evaluation) order — see the swap in lowerDef. Default
  // true; verified byte-exact on agbcc and IDO. A compiler behavior declared in
  // TargetDescription.compilerBehaviors: the first compiler whose scheduler is shown re-ordering
  // independent loads flips it there, not in a code branch. A per-FUNCTION machine-order fallback
  // candidate is deliberately deferred until a row demands it.
  defOrderLoadPairs?: boolean;
  // Anchor a constant merge copy at its const op's ORIGINAL position instead of at the CFG edge:
  // `movs r9, #0` at entry ahead of a single-armed overwrite emits as a pre-initialization above
  // the `if`, not as its else-arm. A differ-refereed candidate variation (rank.ts `/defsite`), never a
  // default — see the refusal conditions where it is computed.
  anchorConstCopies?: boolean;
  // WIDEN `anchorConstCopies` to a LOOP HEADER's entry constant — `int s = 0;` hoisted above the
  // `if` that guards the loop, rather than written on the edge into it. A second placement
  // decision, so a second structure setting (rank.ts `/defsite/loop-entry`) rather than a widening of
  // the first: on a function carrying both kinds of anchorable const, folding them into one flag
  // would make "anchor the plain ones, leave the loop's at its edge" — a spelling `/defsite`
  // emits today — unreachable. Inert unless `anchorConstCopies` is also on.
  //
  // A VARIATION RATHER THAN AN EXTENSION OF `l3/initfirst.ts`, whose header opens on the same rewrite
  // (`if (0 < n) { v = 0; … }` → `v = 0; if (v < n) { … }`) at a fraction of the price: a
  // respell variation adds candidates only where it fires, while this multiplies every candidate below
  // it. The fork is REACH, and it is a hard one. `initfirst` MOVES A STATEMENT, and an edge copy
  // is not a statement — structuring mints it, choosing between the edge and the const op's own
  // position, and the IR that holds those positions is gone by the time L3 runs. So the shapes
  // where the two coincide are initfirst's for free — except that they never do: its guard
  // re-spelling wants an ELSE-LESS `if` and rewrites the condition to read the hoisted variable
  // (`if (v < n)`), where anchoring leaves the condition alone, so the two emit different sources.
  // Measured, not argued: `/initfirst` rides every spelling rank.ts enumerates, so it is scored on
  // every benchmark row already, and on each row this variation wins its `/initfirst`-only sibling is
  // either not enumerated at all or not byte-identical to the anchored source — the substitution
  // reaches none of them. Take the variation only while rows demand that; the price is in rank.ts.
  anchorLoopEntryConsts?: boolean;
  // HARDWARE fact from TargetDescription.capabilities.endianness, threaded by structureOptionsFor:
  // the bitfield extract recognizer solves an LSB-first equation, so it only runs on little-endian
  // data. The provider already refuses to EMIT bitfield facts for a big-endian ELF; this is the
  // same boundary enforced on core's side, against a hand-built map that never went through it.
  littleEndian?: boolean;
  // COMPILER facts about how a declared scalar is stored (TargetDescription.compilerBehaviors), read
  // by the declaration-shape override of `scalarGlobals` (`storageDisagrees`): the bytes an enum
  // takes, and whether a plain `char` is signed. ABSENT ⇒ unmeasured, and a global declared with
  // that type agrees with no access the override is asked about, so it is spelled through its
  // address.
  enumBytes?: number;
  plainCharSigned?: boolean;
  // Does the compiler extend a `volatile` narrow signed read in a register, never in the load? The
  // `declared` stamp structuring re-derives reads it (TargetDescription.compilerBehaviors'
  // `volatileReadsExtendInRegister`), so it leaves unplaced the read the lift's stamp did.
  volatileReadsExtendInRegister?: boolean;
  // Spell `(x << a) >> b` extracts of a struct global as the map's named bitfield member. On by
  // default; rank.ts enumerates the OFF spelling as the `/no-bitfield` variation, because the named
  // read recompiles at the DECLARATION's access width — where that diverges from the asm's load
  // width the honest shift spelling is the one that matches, and the differ referees. Only the map
  // carries the names, so with no `symbols` this is normalized to false whatever a caller passes.
  spellBitfieldMembers?: boolean;
  // Spell an element-scaled offset through a map-declared POINTER MEMBER as a whole-element
  // subscript of it (`gBg.pMap[i + 157]`) rather than as the byte arithmetic it replaces. On by
  // default; rank.ts enumerates the OFF spelling as the `/no-ptr-elem` variation.
  //
  // IT IS A VARIATION AND NOT A DEFAULT BECAUSE IT IS NOT BYTE-NEUTRAL — the bar the block comment
  // above `spellablePointee` sets for a member spelling. Compiled against agbcc (`-mthumb-interwork -Wimplicit -O2 -fhex-asm
  // -fprologue-bugfix`), `((u16 *)gB.pMap)[i + K]` and `*(u16 *)((i << 1) + (u8 *)gB.pMap + 2K)`
  // are the same address and the same instruction COUNT at K = 0, 1 and 157 — and different
  // objects at all three, differing in which register the `add` targets. Which side matches is
  // per-function knowledge the asm does not carry, so both are emitted and the differ referees.
  // Only the map declares a pointee width, so with no `symbols` this is normalized to false.
  spellPtrMemberElements?: boolean;
  // Recover a multidimensional array global's DECLARED subscripts (`g[r][i]`) from a byte residual
  // carrying a term at the declared ROW stride, rather than spelling the whole residual as the
  // `*(T *)(… + (u32)&g)` cast it replaces. On by default; rank.ts enumerates the OFF spelling as
  // the `/flat-rank` variation.
  //
  // IT IS A VARIATION AND NOT A DEFAULT BECAUSE THE ASM DOES NOT DETERMINE IT, and the evidence that
  // it does not is the same compile the recovery's own premise rests on, read against the spelling
  // the recovery DISPLACES rather than against the flat one it refuses. For `u16 g[4][0x400]`:
  //
  //   agbcc  g[a][b]  lsl #0xb ; lsl #0x1 ; add ; add   |  *(u16 *)((a<<11)+(b<<1)+(u32)&g)
  //                   md5 f58a694f…                     |  md5 051bf506…   DIFFERENT, and the
  //                   difference is WHERE THE POOL LOAD SITS — the shift structure the recovery
  //                   reads is IDENTICAL in both, so the residual is evidence about the row and
  //                   NOT about which of these two spellings wrote it.
  //   kmc / mwcc      the same: separate scales both sides, differing only in scheduling.
  //   IDO             the two are BYTE-IDENTICAL (md5 2b55b493…) — and IDO also distributes the
  //                   FLAT sum into the same separate scales, so on that compiler the recovery's
  //                   own premise is false and the flat spelling reaches it too.
  //
  // WHICH ROW OF THAT TABLE IS PINNED: the agbcc pair, by
  // packages/cli/test/matching/array-rank-variation.test.ts, which compiles both spellings through the
  // klonoa checkout's own template. The other three were measured by hand and nothing re-runs
  // them, so treat them as the record of a measurement rather than as a live check.
  //
  // So both are emitted and the differ referees, exactly as for `/no-ptr-elem`. Only the map
  // declares a rank, so with no `symbols` this is normalized to false.
  spellDeclaredSubscripts?: boolean;
  // Let a read of a named global render at its use across writes that PROVABLY cannot reach it
  // (a store to a different named global), instead of caching it in a local. Off by default;
  // rank.ts enumerates the ON spelling as the `/reread-globals` variation — see analysis.ts
  // AnalyzeOptions for why this is a differ-refereed variation and not a fix.
  rereadGlobals?: boolean;
  // Materialize a load that feeds a `cond_br` join arg, so the naming walk can home the join in
  // it and the identity arm elides to a one-sided in-place `if`. Off by default; rank.ts
  // enumerates the ON spelling as the `/inplace` variation — see analysis.ts AnalyzeOptions.
  materializeJoinFeeds?: boolean;
  // Materialize a pure computed address shared by 2+ memory accesses, and the multi-render loads
  // through it, reproducing the source's pointer-local + scalar-temp spelling. Off by default;
  // rank.ts enumerates the ON spelling as the `/addr-home` variation — see analysis.ts AnalyzeOptions.
  homeSharedAddresses?: boolean;
  // Materialize a pure value with 2+ distinct consumers, at least one of them inside a loop the
  // def sits outside — the register the compiler holds across the iterations. Off by default;
  // rank.ts enumerates the ON spelling as the `/expr-home` variation — see analysis.ts AnalyzeOptions.
  homeLoopExprs?: boolean;
  // Materialize a pure value with 2+ consumers standing on a memory read — the register the asm
  // carried the DERIVED value in, where the read's own home is a register that died at the
  // computation. Off by default; rank.ts enumerates the ON spelling as the `/derived-home` variation —
  // see analysis.ts AnalyzeOptions.
  homeDerivedReads?: boolean;
  // Can this compiler FUSE a float multiply into the add or subtract that reads it, when both are
  // written in one expression? Then every such product is named (analysis.ts), so the spelling
  // compiles to the unfused pair the object holds. A compiler opts in; the target says which
  // (`compilerBehaviors.contractsFloatProducts`).
  contractsFloatProducts?: boolean;
  // How this compiler lays out a function-scope static (`compilerBehaviors.staticLayout`), which
  // decides the definition that puts one where the target has it. Absent ⇒ unmeasured, and a
  // function that defines a static declines.
  staticLayout?: StaticLayout;
  // Materialize a pure value that one join's incoming edges render into the SAME parameter slot
  // from 2+ places — the value the source computed once above the branch and the copy machinery
  // sinks into every arm. Off by default; rank.ts enumerates the ON spelling as the `/merge-home`
  // variation — see analysis.ts AnalyzeOptions.
  homeMergeFeeds?: boolean;
  // Materialize a `zext`/`sext` with 2+ consumers, none of them in its own block — the register the
  // asm narrowed into once and every later block read. Off by default; rank.ts enumerates the ON
  // spelling as the `/escape-home` variation — see analysis.ts AnalyzeOptions.
  homeEscapingExtensions?: boolean;
  // Emit a memory read as a named temp in ITS OWN block when every place it renders sits in a
  // block that block strictly dominates. A compiler behavior (TargetDescription
  // .compilerBehaviors), not a differ-refereed variation: where the compiler has neither a scheduler
  // nor a code hoister, the sunk spelling is one it could not have emitted from this asm, so there
  // is nothing to referee. Absent ⇒ off — the target field carries the evidence a compiler owes,
  // analysis.ts AnalyzeOptions the refusals.
  readsStayWhereWritten?: boolean;
  // Spell unsigned compares unsigned: cast an icmp_u* operand where the rendered operands do not
  // guarantee it, and reconcile a mixed-claimant declaration to u32 when nothing under the name
  // needs signed. ON by default, because it is the only spelling that is value-faithful without a
  // proof: an unsigned compare spelled over two signed-rendering operands compiles to a SIGNED
  // compare, which differs from the machine's wherever an operand's top bit is set. The OFF spelling
  // is still a real source: a signed spelling that byte-matched was PROVED non-negative by the
  // compiler (it emits the unsigned branch from signed compares only then), and emission's provable
  // set is smaller than the compiler's. So rank.ts enumerates it as the `/signed-cmp` variation and
  // publishes it only on a byte-exact score (`Candidate.matchOnly`).
  unsignedCompareSpelling?: boolean;
  // Merge two variables that a merge copy would join, when the values under them never interfere
  // (structure/namecoalesce.ts). Off by default; rank.ts enumerates the ON spelling as the
  // `/merge-names` variation. Which variables the compiler's own coalescer shared is not derivable from
  // the naming, and removing a copy is worth less than it looks — the compiler coalesces most of
  // them itself. What moves the score is which values share a register, and that splits per
  // function.
  coalesceMergeNames?: boolean;
  // Give a merge whose carrier is a FUNCTION PARAMETER its own local, instead of assigning back
  // into the parameter's name. Off by default; rank.ts enumerates the ON spelling as the
  // `/fresh-merge` variation, and `FRESH_MERGE_GATES` holds the admission and the argument for it.
  //
  // NOT `materializeJoinFeeds` widened to parameters. That variation reaches its shape by giving the
  // join's feed a NAME to adopt, and materialization is keyed on the defining `Op` — a parameter
  // has none, so there is nothing to key.
  freshParamMerge?: boolean;
  // Give a DIVERGENT `if` — one whose arms reach no common block before EXIT — the follow its
  // non-returning paths share: `followOverReturns` below. Absent, such an `if` keeps its arms
  // divergent and a region both of them reach is emitted in each.
  followEarlyReturns?: boolean;
  // Keep a DIVERGENT `if` or switch outside every loop divergent where its CFG's join is EXIT or a
  // return tail, so everything below it is written into each arm, once more per such branch of a
  // chain: THE RETURN-TAIL COPIES. Absent (the default), such a branch is given the block its
  // non-returning paths meet at as its join (`joinsPastReturns` below) and the code from there is
  // written once. Where that join was taken, the pipeline structures again with this on and
  // publishes whichever reading spells the function in fewer lines, ties to the join, or the copies
  // where the target's layout shows a cross-jumped return tail (pipeline.ts
  // `structureReturnTailReading`), and rank.ts enumerates the other as `/ret-copy` or `/ret-join`;
  // a copies structuring past the copy budget (`COPY_BUDGET`) declines, and the join stands.
  copyReturnTails?: boolean;
  // Can the emitted language spell a `return` before the end of the function? Absent = yes. The
  // join past early returns writes one in each arm that leaves early, where the copies end every
  // arm at the function's end, so a language that cannot (Pascal, `LanguageBackend.spellsEarlyReturn`)
  // is structured reading the copies, as `copyReturnTails` asks. A capability of the backend, like
  // `spellSwitchFallthrough`, never a variation: the default-accepts guard does not reset it.
  spellEarlyReturns?: boolean;
  // How an unresolvable VALUE degrades (a live `opaque`, an unlowered transient op, a dropped def):
  //   "strict"   (default) — the `"?"` sentinel, tripping assertResolved at the boundary (loud in
  //              the PROCESS);
  //   "annotate" — a `marker` node that spells as the undefined ASMLIFT_ERROR(...) symbol (loud in
  //              the ARTIFACT: the function emits complete, but cannot compile un-acknowledged).
  onGap?: 'strict' | 'annotate';
  /** NAME-keyed project symbol facts (symbols.ts `symbolsByName`) — drives the byte-sensitive
   *  declaration-shape spellings: `shape:'array'` forces the aggregate classification and the
   *  bare `gSym[i]` form; `shape:'struct'`+layout spells interiors as `gSym.field`. Absent (or
   *  a symbol not in the map) ⇒ today's usage-inferred behavior, byte-identical. */
  symbols?: Map<string, SymbolInfo>;
  /** ARRAY SHAPES DERIVED FROM THE INPUT ASSEMBLY (raise/globalshape.ts) for globals the project
   *  map does not describe — same `SymbolInfo` shape, same readers, LOWER precedence: `symbols`
   *  wins every name it knows, because a project declaration knows more than an inference off one
   *  function's strides.
   *
   *  A SEPARATE FIELD rather than a pre-merged map, and the separation is load-bearing twice.
   *  `spellBitfieldMembers` is normalized against `symbols` alone, so a derived shape can never
   *  switch the named-bitfield spelling on for a map-less row (which would silently delete the
   *  `/no-bitfield` variation's decline — see bitfield-members.test.ts). And it keeps the derivation
   *  ATTRIBUTABLE: everything the map does stays keyed on the map. */
  inferredSymbols?: Map<string, SymbolInfo>;
  /** THE ORDER HALF of the same derivation (raise/globalshape.ts `orderLicensedGlobals`): the
   *  globals whose address the assembly materialized BEFORE it scaled the index. Not a shape and
   *  not a declaration — nothing is spelled from it here — it is stamped onto every `index` node it
   *  reaches (`Expr.baseOrdered`, l3/ast.ts) for the L3 pass that decides whether a base gets a
   *  HOME.
   *
   *  A SUPERSET of `inferredSymbols`' names, and its own field for exactly that reason: a struct
   *  element is licensed here and has no shape there. */
  orderLicensedGlobals?: ReadonlySet<string>;
  /** The globals the project map declares POINTERS, handed to a structuring that runs without the
   *  map (rank.ts `/raw-globals`). Spelling a global raw does not make it an integer: C still scales
   *  arithmetic on its value by the declared pointee, so the byte-arithmetic rules read this where
   *  they would read the map's `shape:'pointer'`. The operand-order rules do not read it: no element
   *  or field spelling folds from a name with no pointee. */
  pointerGlobals?: ReadonlySet<string>;
  /** What the declaration context states about its globals (proto-context.ts `globalsFromContext`):
   *  which are structs, unions or arrays, and which are volatile, read by the stamp this structuring
   *  re-derives. Read with the map setting and without it: a context declaration is what every
   *  candidate compiles against, whichever names it spells. */
  contextGlobals?: ContextGlobals;
  /** `contextGlobals.arrayElements` laid out on this target: each context-declared array of a
   *  struct, its element as an IR struct (`aggregate.ts` `aggregateType`, named members at the
   *  target's offsets) and the array's rank. Built where the target is in hand
   *  (structuring-options.ts), on a target whose declared-array subscript is its own object
   *  (`arrayShapeFromStride`); an element this target does not size is left out. Read where an
   *  element's member is spelled through the declared array (memory-access.ts
   *  `declaredElementMember`). */
  contextArrayElements?: ReadonlyMap<string, { readonly type: IrType; readonly rank: number }>;
}

/** Where one `if`, comparison tree or jump table took the join past its early returns
 *  (`StructureHooks.onJoinPastReturns`): its branch block, the join, and which recovery took it. */
export interface JoinPastReturnsSite {
  readonly branch: Block;
  readonly join: Block;
  readonly kind: 'if' | 'tree' | 'switch';
}

/** Test-only seams. SEPARATE from `StructureOptions` on purpose: `structureOptionsFor` builds that
 *  one by spreading a target's `compilerBehaviors`, whose fields map 1:1 onto it, so a hook living
 *  there would be settable from a TargetDescription. */
export interface StructureHooks {
  /** `coalesceMergeNames`'s admission rules, so a test can run the pass with one gate DROPPED —
   *  the ablation as a value rather than as a flag compiled into the shipped path. */
  nameCoalesceGates?: readonly Gate<NameMerge>[];
  /** `freshParamMerge`'s admission rules, ablatable the same way. */
  freshMergeGates?: readonly Gate<FreshMergeCarrier>[];
  /** `canTakeName`'s admission rules — which name a block parameter may be spelled with. Every
   *  entry is sound, so this exists for the differential test that drops one and watches the
   *  emitted program change, never for a shipped ablation. */
  carrierNameGates?: readonly Gate<CarrierName>[];
  /** `enclosingCarrierName`'s admission rules (`ENCLOSING_CARRIER_GATES`), ablatable the same way —
   *  and, wrapped in `tallying`, the census of which rule refuses a nest. */
  enclosingCarrierGates?: readonly Gate<EnclosingCarrier>[];
  /** `sinkablePreUpdateSlots`'s per-slot rules (`PREUPDATE_SINK_GATES`), ablatable the same way. */
  preUpdateSinkGates?: readonly Gate<SinkCandidate>[];
  /** `earlyReturnArm`'s `exitTail` rules (`EXIT_TAIL_GATES`), ablatable the same way. */
  exitTailGates?: readonly Gate<ExitTailCandidate>[];
  /** `earlyReturnArm`'s `bypassTail` rules (`BYPASS_TAIL_GATES`), ablatable the same way. */
  bypassTailGates?: readonly Gate<BypassTailCandidate>[];
  /** `foreverShape`'s two-level exit rules (`TWO_LEVEL_EXIT_GATES`), ablatable the same way. */
  twoLevelExitGates?: readonly Gate<TwoLevelCandidate>[];
  /** `outwardExitOf`'s rules (`OUTWARD_EXIT_GATES`), ablatable the same way. */
  outwardExitGates?: readonly Gate<OutwardExitCandidate>[];
  /** `codeBreakArm`'s rules for a shared tail holding a cycle (`BREAK_TAIL_GATES`), ablatable the
   *  same way. */
  breakTailGates?: readonly Gate<BreakTailCycle>[];
  /** `emitForever`'s two-level exit rule (`TWO_LEVEL_REGION_GATES`), ablatable the same way. */
  twoLevelRegionGates?: readonly Gate<TwoLevelRegion>[];
  /** the two-level exit's `break` rule (`TWO_LEVEL_BREAK_GATES`), ablatable the same way. */
  twoLevelBreakGates?: readonly Gate<TwoLevelBreak>[];
  /** `forPlanAt`'s rules (`FOR_PLAN_GATES`, `FOR_PLAN_IV_GATES`), ablatable the
   *  same way and, wrapped in `tallying`, the census of which rule refuses a loop's `for`. */
  forPlanGates?: readonly Gate<ForPlanCandidate>[];
  forPlanIvGates?: readonly Gate<ForPlanIv>[];
  /** the rules over each reading of a latch's `!=` test as a compare (`FOR_BOUND_GATES`) */
  forBoundGates?: readonly Gate<ForBoundReading>[];
  /** Every branch-sense site this structuring reached, in emission order: the block index
   *  `StructureOptions.branchSenseFlipSites` names, whether the site is JOINED or divergent, and
   *  which sense it actually emitted. The enumeration domain — a site only exists once structuring
   *  has decided both arms are real, so it cannot be computed ahead of the pass. */
  onBranchSenseSite?: (site: { block: number; ordinal: number; joined: boolean; negated: boolean }) => void;
  /** Every branch `followOverReturns` gave a follow: the branch's block and the follow's. Both
   *  callers fire it — a divergent `if` under `followEarlyReturns`, EVERY jump table whose arms all
   *  return, unconditionally, and a jump table whose default-anchored RETRY is adopted (some arms
   *  return, the rest reach the code after it) — so the sites it reports are not the enumeration
   *  domain of the shared-tail twins (that domain is `hasDivergentSharedRet`, which asks for a
   *  `cond_br`). */
  onEarlyReturnFollow?: (site: { block: number; follow: number }) => void;
  /** Fired each time an `if` or a jump table takes the join past early returns (the default, off
   *  under `copyReturnTails`) where its CFG join differs: the one place the reading changes a tree.
   *  Held, like the other observation hooks, until the run that fired it is the one returned.
   *  pipeline.ts `structureReturnTailReading` structures the copies only for a structuring that
   *  fired it: under one that never did, the copies are its tree already. The site says where:
   *  the branch block, the join taken past its early returns, and which recovery took it; the
   *  chooser reads the target's asm layout there (structure/cross-jumped-tail.ts). */
  onJoinPastReturns?: (site: JoinPastReturnsSite) => void;
  /** Fired each time a jump table's cross-jumped sibling is read with an entrant left FALLING into
   *  it (`copySharedFallTargets`' `onFallerKept`) — the one place `copyEveryTailEntrant` changes
   *  what the structurer reads. A structuring with that option off that never fires it builds the
   *  same tree as the same options with it on, so rank.ts skips `/tail-copies` on its sibling
   *  rather than structure a tree the dedup would discard. Like `onBranchSenseSite`, the domain
   *  only exists once structuring has picked the switch's merge and walked its arms, so no
   *  question of the raised fn answers it ahead of the pass: a block two arms reach is not a
   *  sibling where it is the merge, and two entrants can reach their sibling through one shared
   *  cross-jumped block. Not fired by `assertDefaultAccepts`' structuring, which is not the
   *  setting being observed. */
  onTailFallerKept?: () => void;
  /** Fired each time the copies write a CASE arm's body back into an entrant
   *  (`copySharedFallTargets`' `onCopied`, a sibling that is not the `default:` arm) — the one
   *  place `jumpToSharedCases` changes what the structurer reads. A structuring with that option off
   *  that never fires it builds the same tree as the same options with it on, so rank.ts skips
   *  `/case-goto` on its sibling. Not fired by `assertDefaultAccepts`' structuring. */
  onCaseCopied?: () => void;
  /** Fired each time a `while (1)` loop no run asked for (`ForRanking`) passes every check of
   *  `forPlanAt` — a single pure latch, a guard or plain entry, a test and update read only from the
   *  latch, the header's params and values from outside the loop, one update copy, and the guard
   *  (or the folded first test) read on the entry values — the one place `spellCountedLoopsFor` changes what the structurer
   *  reads. A structuring with that option off that never fires it builds the same tree as the same
   *  options with it on, so rank.ts skips `/for-continue` on its sibling. Not fired by
   *  `assertDefaultAccepts`' structuring. */
  onForOffered?: () => void;
  /** Fired each time `bound-plus-one-counter-wraps` is the rule that refuses a reading of a latch's
   *  `!=` test: the one refusal of `forPlanAt` that reads how the signedness pin declared the
   *  counter, so the other pin may take the `for` this one cannot. Unheld: it fires from every
   *  attempt, committed or not, so it is a NECESSARY condition only. rank.ts reads it as the cheap
   *  filter ahead of its causation probe (`declinesOnCounterSign`, the same structuring with the rule
   *  off), and only a decline that probe ties to the rule falls through to the signed pin. */
  onCounterSignRefused?: () => void;
  /** Fired once by a structuring that reads the return-tail copies (`copyReturnTails`) and LIFTS,
   *  where the same structuring reading the join past early returns would have taken every step it
   *  took: at no branch it asked would the join have been asked and moved anything (`JoinReading`'s
   *  `differs`, structure.ts). Such a join run is this run, step for step, so it lifts the same tree,
   *  fires the same hooks and takes no join (`onJoinPastReturns`) — the copies' run already, as
   *  `structureWithinBudget` says of a join run that never asked. Unheld, and a positive claim: a run
   *  that does not fire it says nothing. pipeline.ts `copiesByDefault` reads it to skip structuring a
   *  join whose tree it would discard. Not fired by `assertDefaultAccepts`' structuring. */
  onJoinReadsAsCopies?: () => void;
}

/** Each declared-callee table's own key order, name → position, computed once per table object: the
 *  ranked pass structures every candidate against the same tables. */
const keyOrders = new WeakMap<object, ReadonlyMap<string, number>>();
function keyOrder(table: object): ReadonlyMap<string, number> {
  let order = keyOrders.get(table);
  if (order === undefined) {
    order = new Map(Object.keys(table).map((n, i) => [n, i]));
    keyOrders.set(table, order);
  }
  return order;
}

/** Of each table of declared callees, the entries this body calls — every tree the ranked pass
 *  structures carries its own, and is keyed by its whole text. A table this body calls nothing in is
 *  absent. */
export function calledOnly(
  tables: Pick<StructureOptions, 'declaredArgs' | 'declaredReturns'>,
  body: Stmt[],
): Pick<StructureOptions, 'declaredArgs' | 'declaredReturns'> {
  const callees = new Set<string>();
  for (const e of walkExprs(body)) {
    if (e.k === 'call' && typeof e.fn === 'string') {
      callees.add(e.fn);
    }
  }
  // Look up the few names this body calls, not every entry of the table: a project's table holds
  // every function its ELF declares (thousands for pokeemerald), and this runs on each structuring
  // of each candidate. The result keeps the TABLE's key order, as a whole-table filter would,
  // because the tree is keyed by its whole text.
  const of = <T>(table: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined => {
    if (table === undefined || callees.size === 0) {
      return undefined;
    }
    const order = keyOrder(table);
    const names = [...callees].filter((n) => order.has(n)).sort((a, b) => order.get(a)! - order.get(b)!);
    return names.length > 0 ? Object.fromEntries(names.map((n) => [n, table[n]])) : undefined;
  };
  const declaredArgs = of(tables.declaredArgs);
  const declaredReturns = of(tables.declaredReturns);
  return { ...(declaredArgs ? { declaredArgs } : {}), ...(declaredReturns ? { declaredReturns } : {}) };
}
