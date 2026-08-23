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
// GATE — VOL_SLOT_GATES holds the rules; the argument behind each is here, where there is room:
//
//   • The frame record is what gives the qualifier a home to force. Qualifying a register-homed
//     value would enumerate a spelling no source that produced this asm could have had.
//   • SCALAR, because a pointer local declares as `volatile u16 * p` — one prefix, two meanings —
//     and cfamily.ts spells that for `pointeeVolatile`. On a pointer the qualifier would say
//     something about the pointee the tree never claimed.
//   • `volatile` already set is the frontend's stamp for an object whose address was PUBLISHED
//     to memory (frontend/thumb.ts stamps it there, on `published`, not on any escape) — the
//     candidate would duplicate the primary.
//   • An address-TAKEN local already has a memory home in every spelling, so there is no home
//     left for the qualifier to move: EReader_Reset's slot read and written through a pointer
//     local compiles to IDENTICAL assembly with the qualifier and without (agbcc 2.9-arm-000512,
//     `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`). What it can still do
//     there is stop reads collapsing, which frontend/thumb.ts measured turning a byte-exact
//     candidate into a four-instruction nonmatch.
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
//
// ALL ELIGIBLE SLOTS OR NONE, where the sibling pointee lever enumerates per-local SUBSETS on the
// argument that volatility is per-pointer knowledge. It is per-slot knowledge here too; the
// subsets are simply uninhabited — of 311 agbcc benchmark rows, one reaches this gate at all, and
// none reaches it with two eligible slots.
import type { SFn } from './ast';
import { type Gate, firstRejection } from './gates';
import { localMentions, readsOf } from './mentions';

/** One local as the gates read it. */
interface SlotCtx {
  hasFrame: boolean;
  isScalar: boolean;
  alreadyVolatile: boolean;
  addrTaken: number;
  /** the tree's reads and writes are the machine's loads and stores */
  accessSetKept: boolean;
}

export const VOL_SLOT_GATES: readonly Gate<SlotCtx>[] = [
  {
    id: 'no-frame',
    why: 'the frame record is the memory home the qualifier has to force',
    sound: false,
    rejects: (c) => !c.hasFrame,
  },
  {
    id: 'non-scalar',
    why: 'on a pointer declarator the one `volatile` prefix binds to the pointee, not the object',
    sound: true,
    guardedBy: 'volatileval.test.ts: a non-scalar frame local never qualifies',
    rejects: (c) => !c.isScalar,
  },
  {
    id: 'already-volatile',
    why: 'the primary already declares it, so the candidate would duplicate it',
    sound: false,
    rejects: (c) => c.alreadyVolatile,
  },
  {
    id: 'addr-taken',
    why: 'an address-taken local already has a memory home, so there is none left to force',
    sound: false,
    rejects: (c) => c.addrTaken > 0,
  },
  {
    id: 'access-set',
    why: 'the qualifier asserts every access written is performed, so the tree’s must be the machine’s',
    sound: true,
    guardedBy: 'volatileval.test.ts: a store the tree no longer carries declines',
    rejects: (c) => !c.accessSetKept,
  },
];

/** the shared eligibility predicate (VOL_SLOT_GATES) for one function's locals */
function eligibility(sfn: SFn): (l: SFn['locals'][number]) => boolean {
  const uses = localMentions(sfn);
  return (l) => {
    const u = uses.get(l.name);
    if (u === undefined) {
      return false;
    }
    return (
      firstRejection(VOL_SLOT_GATES, {
        hasFrame: l.frame !== undefined,
        isScalar: l.type.kind === 'int',
        alreadyVolatile: l.volatile !== undefined || l.pointeeVolatile !== undefined,
        addrTaken: u.addrTaken,
        accessSetKept: readsOf(u) === l.frame?.loads && u.assigns === l.frame?.stores,
      }) === null
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
