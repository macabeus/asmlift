// L3 re-spelling lever: DELETE a pointer local holding a CONSTANT address and spell each access
// through it as the cast constant (`*(u16 *)0x4000208` rather than `p = (u16 *)0x4000208; *p`).
//
// The local is structure/analysis.ts's value-home spelling for a `const` with 2+ consumers that
// is LIVE ACROSS A CALL: a value the compiler needs after a call survives in a callee-saved
// register, and a named local reproduces that register. The machine fact is real — agbcc does
// park the address in `r4` across the calls — but it does NOT imply the source named anything:
// a constant re-spelled at each use is CSEd into the same one register. So the asm
// underdetermines the spelling, and this is the differ-refereed other side of it.
//
// It is codegen-visible, which is why both sides have to be enumerated rather than one picked:
// the extra `p = …;` statement is scheduled ahead of the rest of the entry block, so the pool
// load moves in front of the frame-address materialization the target emits first
// (pokeemerald:EReader_Reset, agbcc 2.9-arm-000512 — 1 insert + 1 delete, the whole residual).
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION: this is constant propagation of a local that is
// assigned once, from a compile-time constant, before anything mentions it, and whose address is
// never taken — so every use reads that constant on every path, and the substituted expression
// carries the local's own declared type AND its pointee volatility.
//
// THE QUALIFIER TRAVELS WITH THE ADDRESS. The deleted local is the only place a `volatile`
// pointee could be written, and a raw address is precisely the case with no declaration
// anywhere else to carry it — so dropping it here spells an MMIO access non-volatile in the one
// place the differ sometimes cannot referee. On pokeemerald:EReader_Reset the two spellings
// separate at 11 against 12 on their own, and are BYTE-IDENTICAL once the slot qualifier is
// there too — the shape that matches (agbcc 2.9-arm-000512, `-O2 -mthumb-interwork -Wimplicit
// -fhex-asm -fprologue-bugfix`; `.s` diff empty, `.o` identical under cmp). So rank.ts emits
// the qualified spelling as a second OUTPUT of this lever, `/volatile` narrowed to the locals
// it deletes. Each cast this mints carries the qualifier; a use whose width does not stride the
// declared pointee renders through the C-family printer's reinterpret cast instead, which
// carries it too (backend/cfamily.ts) — in C the access takes the OUTER type, so a plain cast
// there would spell exactly the silent drop this paragraph exists to prevent.
//
// GATE (INLINEBASE_GATES) — the local must be all of: pointer-typed; initialized by a bare
// NONZERO `const` (a `(T *)base` CAST initializer is l3/basecse.ts's reuse hoist, whose own lever
// family owns that question; `0` is NULL, never an address, which is also the sibling qualifier
// lever's rule); assigned exactly once, by a statement at the body's TOP LEVEL that no earlier
// statement's mention precedes; never address-taken; used only as the base of an `index`, at 2+
// sites (one use is not the reused address this exists for); not object-`volatile` (a
// `T *volatile p` has no inhabitant, and cfamily.ts prints that flag in the pointee's position);
// and not `frame` (a slot is an asm fact — see the SFn.locals doc). Anything else, and nothing
// qualifying at all, DECLINES (null) rather than approximating.
//
// KNOWN GAP: only `index` bases are re-spelled, so the same L2 home passed to a callee or used
// as a `field` base is out of reach — `otherUses` refuses it. Re-spelling those
// needs the un-homed tree, which is structure/analysis.ts's decision, not a substitution.
import { type Expr, type SFn, mapExprChildren, mapStmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { type Mentions, localMentions } from './mentions';

/** One local as the gates read it. */
interface BaseCtx {
  isPointer: boolean;
  objectVolatile: boolean;
  hasFrame: boolean;
  m: Mentions;
}

export const INLINEBASE_GATES: readonly Gate<BaseCtx>[] = [
  {
    id: 'non-pointer',
    why: 'the lever re-spells an address; a scalar value home is a different question',
    sound: false,
    rejects: (c) => !c.isPointer,
  },
  {
    id: 'object-volatile',
    why: 'the substitution carries the POINTEE flag, so an object-volatile pointer would lose its own',
    sound: true,
    guardedBy: 'inlinebase.test.ts: an object-volatile or frame local declines',
    rejects: (c) => c.objectVolatile,
  },
  {
    id: 'frame',
    why: 'a slot the asm materialized is an asm fact, not a spelling to undo',
    sound: false,
    rejects: (c) => c.hasFrame,
  },
  {
    id: 'multi-assign',
    why: 'a name assigned more than once is not one constant',
    sound: true,
    guardedBy: 'inlinebase.test.ts: a second assignment means the name is not one constant',
    rejects: (c) => c.m.assigns !== 1,
  },
  {
    id: 'const-init',
    why: 'only a bare `const` at the body’s top level is an address available on every path',
    sound: true,
    guardedBy: 'inlinebase.test.ts: an assignment below the top level may not run on every path',
    rejects: (c) => c.m.topAssignAt === null || c.m.constValue === null,
  },
  {
    id: 'null-base',
    why: '`0` is NULL, never an address — the sibling qualifier lever (volatileptr.ts) refuses it too',
    sound: false,
    rejects: (c) => c.m.constValue === 0,
  },
  {
    id: 'use-before-assign',
    why: 'a mention ahead of the assignment reads something the constant does not stand for',
    sound: true,
    guardedBy: 'inlinebase.test.ts: a use in a loop ABOVE the assignment reads the local before it is set',
    rejects: (c) => c.m.firstAt !== c.m.topAssignAt,
  },
  {
    id: 'addr-taken',
    why: 'a deleted local has no address to take',
    sound: true,
    guardedBy: 'inlinebase.test.ts: an address-taken local has an identity the constant cannot stand in for',
    rejects: (c) => c.m.addrTaken !== 0,
  },
  {
    id: 'other-uses',
    why: 'a use the substitution cannot reach would name the deleted local',
    sound: true,
    guardedBy: 'inlinebase.test.ts: a use that is not an `index` base is outside what the lever re-spells',
    rejects: (c) => c.m.otherUses !== 0,
  },
  {
    id: 'single-use',
    why: 'one use is not the reused address this lever exists for',
    sound: false,
    rejects: (c) => c.m.baseUses < 2,
  },
];

/** The locals INLINEBASE_GATES admits, each with the cast its uses become. */
function plan(sfn: SFn): Map<string, Extract<Expr, { k: 'cast' }>> {
  const t = localMentions(sfn);
  const out = new Map<string, Extract<Expr, { k: 'cast' }>>();
  for (const l of sfn.locals) {
    const m = t.get(l.name);
    if (
      m === undefined ||
      firstRejection(INLINEBASE_GATES, {
        isPointer: l.type.kind === 'ptr',
        objectVolatile: l.volatile !== undefined,
        hasFrame: l.frame !== undefined,
        m,
      }) !== null
    ) {
      continue;
    }
    out.set(l.name, {
      k: 'cast',
      to: l.type,
      ...(l.pointeeVolatile ? { volatile: true as const } : {}),
      e: { k: 'const', value: m.constValue! },
    });
  }
  return out;
}

/** Which locals this lever would delete — rank.ts narrows `/volatile` to exactly these before
 *  pairing, so the qualified output never qualifies a pointer the lever leaves standing. */
export function inlinableConstBases(sfn: SFn): string[] {
  return [...plan(sfn).keys()];
}

/** The `/inlinebase` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  whose body is rebuilt, leaving the input untouched. */
export function inlineConstBases(sfn: SFn): SFn | null {
  const inline = plan(sfn);
  if (inline.size === 0) {
    return null;
  }
  // A FRESH node per use — never one shared tree — because identity-keyed rules downstream
  // (contracts.ts's dot-base exemption) read node identity.
  const sub = (e: Expr): Expr => {
    if (e.k === 'var') {
      const at = inline.get(e.name);
      if (at !== undefined) {
        return { ...at, e: { ...at.e } };
      }
    }
    return mapExprChildren(e, sub);
  };
  const body = sfn.body.filter((s) => !(s.k === 'assign' && inline.has(s.name))).map((s) => mapStmtExprs(s, sub));
  return { ...sfn, locals: sfn.locals.filter((l) => !inline.has(l.name)), body };
}
