// L3 re-spelling lever: declare a stack-homed scalar local `volatile` (`volatile u16 sp0;`).
//
// `volatile` on a scalar VALUE local FORCES the value into memory: agbcc's allocator is
// otherwise free to keep it in a callee-saved register across a call, and no other qualifier
// or type spelling takes that freedom away. Whether the source spelled it is not derivable from
// the asm — a slot-homed value can equally come from an address-taken local or from plain
// register pressure — so both spellings are emitted and the differ referees, exactly as the
// sibling pointee lever (volatileptr.ts) does for a numeric-address pointer.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION, as they are there: `volatile` only RESTRICTS what a
// compiler may do with the accesses, so every execution of the qualified spelling is an
// execution of the plain one. The object is a function local whose address does not escape,
// so nothing outside the function can observe the difference at all.
//
// ENVELOPE — narrower than "a source-level volatile scalar": an `laddr`-recovered frame object,
// which under Thumb is a SUB-WORD one (see the `frame` note on SFn.locals). A `volatile s32`
// local spills straight to `[sp,#imm]` and is recovered as an ordinary value with no local of
// its own, so this lever cannot reach it. The flag is the set of slots asmlift PROVED, not the
// set of values a source could have qualified.
//
// GATE: a `frame` local of scalar integer type, carrying neither volatility flag already, whose
// address is not taken anywhere in the body, and whose accesses in this tree are exactly the
// machine's. Four reasons, in that order:
//
//   • The frame record is what gives the qualifier a home to force. Qualifying a register-homed
//     value would enumerate a spelling no source that produced this asm could have had.
//   • `volatile` already set is the frontend's stamp for an object whose address was PUBLISHED
//     to memory (frontend/thumb.ts stamps it there, on `published`, not on any escape) — the
//     candidate would duplicate the primary.
//   • An address-TAKEN local already has a memory home in every spelling, so there is no home
//     left for the qualifier to move: EReader_Reset's slot read and written through a pointer
//     local scores 9 with the qualifier and 9 without, the same breakdown both ways (agbcc
//     2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`). What it
//     can still do there is stop reads collapsing, which frontend/thumb.ts measured turning a
//     byte-exact candidate into a four-instruction nonmatch.
//   • ACCESS-SET EQUALITY is what makes the qualified spelling honest, and it is the one
//     condition the tree alone cannot answer. `volatile` asserts that every access written is an
//     access performed; the passes between the asm and here break that in both directions and
//     leave no trace. eliminateDeadStores drops a store to a local it can see is dead — licensed
//     by the ABSENCE of the flag this lever adds — so a source that stores the slot twice
//     arrives with one store. And the structurer emits one C read per USE rather than per
//     machine load, so one `ldrh` feeding two uses arrives as two reads. Either way the
//     qualified spelling would declare an access set asmlift did not preserve, so both DECLINE.
//
// No qualifying local ⇒ decline (null), so the lever never emits a duplicate of the primary.
import { type Expr, type SFn, type Stmt, exprChildren, stmtChildren, stmtExprs } from './ast';

/** What this tree does to one local: address-takings, reads, writes. */
interface Uses {
  addrTaken: number;
  reads: number;
  writes: number;
}

/** Tally every mention of every local, keyed by name. */
function tally(sfn: SFn): Map<string, Uses> {
  const t = new Map<string, Uses>(sfn.locals.map((l) => [l.name, { addrTaken: 0, reads: 0, writes: 0 }]));
  const walk = (e: Expr): void => {
    if (e.k === 'var' || e.k === 'addr') {
      const u = t.get(e.name);
      if (u) {
        if (e.k === 'addr') {
          u.addrTaken++;
        } else {
          u.reads++;
        }
      }
    }
    for (const c of exprChildren(e)) {
      walk(c);
    }
  };
  const stmt = (s: Stmt): void => {
    if (s.k === 'assign') {
      const u = t.get(s.name);
      if (u) {
        u.writes++;
      }
    }
    for (const e of stmtExprs(s)) {
      walk(e);
    }
    for (const c of stmtChildren(s)) {
      stmt(c);
    }
  };
  for (const s of sfn.body) {
    stmt(s);
  }
  return t;
}

/** the shared eligibility predicate (the GATE in the header) for one function's locals */
function eligibility(sfn: SFn): (l: SFn['locals'][number]) => boolean {
  const uses = tally(sfn);
  return (l) => {
    const u = uses.get(l.name);
    return (
      u !== undefined &&
      l.frame !== undefined &&
      // a pointer local declares as `volatile u16 * p`, which cfamily.ts also spells for
      // `pointeeVolatile` — one prefix, two meanings — so the object qualifier stays on scalars
      l.type.kind === 'int' &&
      l.volatile === undefined &&
      l.pointeeVolatile === undefined &&
      u.addrTaken === 0 &&
      u.reads === l.frame.loads &&
      u.writes === l.frame.stores
    );
  };
}

/** The `/vol-slot` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. */
export function volatileValueLocals(sfn: SFn): SFn | null {
  const qualifies = eligibility(sfn);
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, volatile: true as const } : l)) };
}
