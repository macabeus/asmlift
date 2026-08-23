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
// GATE: a `frame` local (the structurer recovered it from an `laddr`, so the MACHINE gave it a
// slot) of scalar integer type, carrying neither volatility flag already, whose address is not
// taken anywhere in the body. Three reasons, in that order:
//
//   • The frame flag is not a restriction that loses inhabitants, it IS the inhabitant set: a
//     source-level `volatile` scalar cannot live in a register, so every one of them shows up
//     as a slot. Qualifying a register-homed value would enumerate a spelling no source that
//     produced this asm could have had.
//   • `volatile` already set means the frontend proved the address ESCAPED (frontend/thumb.ts
//     stamps it there) — the candidate would duplicate the primary.
//   • An address-TAKEN local already has a memory home in every spelling, so there is no home
//     left for the qualifier to move: EReader_Reset's slot read and written through a pointer
//     local scores 9 with the qualifier and 9 without, the same breakdown both ways (agbcc
//     2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`). What it
//     can still do there is stop reads collapsing, which frontend/thumb.ts measured turning a
//     byte-exact candidate into a four-instruction nonmatch.
//
// No qualifying local ⇒ decline (null), so the lever never emits a duplicate of the primary.
import { type Expr, type SFn, type Stmt, exprChildren, stmtChildren, stmtExprs } from './ast';

/** Every name whose ADDRESS is taken anywhere in these statements. */
function addrTakenInto(stmts: Stmt[], out: Set<string>): void {
  const walk = (e: Expr): void => {
    if (e.k === 'addr') {
      out.add(e.name);
    }
    for (const c of exprChildren(e)) {
      walk(c);
    }
  };
  for (const s of stmts) {
    for (const e of stmtExprs(s)) {
      walk(e);
    }
    addrTakenInto(stmtChildren(s), out);
  }
}

/** the shared eligibility predicate (the GATE in the header) for one function's locals */
function eligibility(sfn: SFn): (l: SFn['locals'][number]) => boolean {
  const addressTaken = new Set<string>();
  addrTakenInto(sfn.body, addressTaken);
  return (l) =>
    l.frame === true &&
    l.type.kind === 'int' &&
    l.volatile === undefined &&
    l.pointeeVolatile === undefined &&
    !addressTaken.has(l.name);
}

/** The `/vol-slot` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. `only` narrows the lever to the named locals, the same door
 *  volatilePtrLocals opens for its products and subsets. */
export function volatileValueLocals(sfn: SFn, only?: ReadonlySet<string>): SFn | null {
  const eligible = eligibility(sfn);
  const qualifies = (l: SFn['locals'][number]): boolean => eligible(l) && (only === undefined || only.has(l.name));
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, volatile: true as const } : l)) };
}
