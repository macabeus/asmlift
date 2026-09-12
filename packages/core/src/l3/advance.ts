// L3 re-spelling lever: a pointer local the source ADVANCED between two accesses, rather than two
// addresses the compiler derived from one.
//
// `ldr r3,=X; strh [r3]; adds r3,#2; strh [r3]` — the machine held an address in a register, used
// it, moved it, used it again. `raise/const.ts` folds the lift's `add(const X, const 2)` into the
// literal `X + 2`, because on Thumb that pair is also how a compiler materialises a 32-bit literal
// it cannot encode in one instruction, and it records the distinction it is erasing as
// `index.baseAdvanced` (l3/ast.ts's third evidence field). This pass reads it:
//
//     *(u16 *)0x04000048 = a;  *(u16 *)0x0400004A = b;
//   → u16 *p = (u16 *)0x04000048;  *p = a;  p = p + 1;  *p = b;
//
// WHY IT IS A CANDIDATE. Against the INDEXED spelling of the same minted local the advance buys
// nothing: agbcc folds `p = p + 1; *p` straight back into `strh [r3, #2]`, byte for byte the
// subscript's own object. What makes it visible is the CONJUNCTION with a `volatile` pointee,
// which bars that fold and leaves the `add` the target records. Both halves were compiled against
// `kleod:StreamCmd_SetWindowRegs`'s target object before this pass was written; the four corners
// are in test/advance.test.ts's header. So this pass emits a spelling and `compareScored`
// referees; nothing here claims the source wrote it.
//
// SOUNDNESS IS ADDRESS EQUALITY, and exactly TWO of the rules below carry it. `p` is freshly
// minted and assigned by nothing else, so at each member's access it holds `A0 + Σ steps so far` —
// that member's own absolute address — PROVIDED every advance sits between the accesses it
// separates on every path. A top-level statement list has no back edge and runs its statements in
// order at most once each, so placing each advance at the top level immediately above its member's
// statement, with the members at STRICTLY INCREASING top-level indices, is what makes that true.
// Everything else the function spells is untouched, including a second access at one of these
// addresses.
//
// SCOPE (decline over approximate). A chain forms only when ALL hold —
//   • every member is a CONST-ADDRESSED access (`l3/address.ts` cellAddress: a scalar-cast const
//     base, a constant subscript, no leading dimension), and the members sit at strictly
//     increasing TOP-LEVEL statement indices — the soundness rule above;
//   • each member after the first carries `baseAdvanced` equal to its byte distance from the
//     member before it. Equality is the whole gate: the evidence names a step, and a step that
//     does not land on the next access is evidence about some other pair of addresses;
//   • every member shares the first's `width` and `signed`, and every step is a multiple of that
//     width — the minted local is a `T *` and the advance is `p = p + step / width`, so a step off
//     the element grid has no spelling here.
// Three more NARROW IT RATHER THAN MAKE IT SOUND. Each is UNWITNESSED — no corpus row has been
// shown to inhabit the shape it excludes, and none was instrumented to say how often it fires —
// so each is named as debt here rather than defended as a rule:
//   • an access inside an arm or a loop body is not admitted as a member (its address joins the
//     second-site set instead). Placed at the top level the advance would still be address-
//     correct — a conditionally reached `*p` beside an unconditional `p = p + 1` is a spelling no
//     corpus row asks for, and reading one into the asm is a guess;
//   • an address reached at a SECOND admissible site declines the chain. Rewriting one site and
//     leaving its twin absolute is correct and is two spellings of one cell, which nothing here
//     can settle;
//   • a NEGATIVE step declines rather than spelling `p = p + -1`. Unpinned direction, no
//     inhabitant.
// A function with no chain declines (null) and enumerates nothing.
import { type IrType, scalarTypeForAccess } from '../ir/types';
import { cellAddress } from './address';
import { type Expr, type SFn, type Stmt, mapExprChildren, mapStmtExprs, stmtChildren, stmtExprs } from './ast';
import type { BaseInit } from './hoist';
import { nameAllocator, placeBaseLocals } from './hoist';

/** One const-addressed access, with the top-level statement it was reached at. */
interface Site {
  stmt: number;
  addr: number;
  width: number;
  signed: boolean;
  advanced?: number;
}

/** Every const-addressed `index` node in the body, split into the ones reached EXACTLY ONCE per
 *  execution of a top-level statement — the only places an advance statement can be put — and the
 *  ADDRESSES of every other one, which the chain rule refuses outright.
 *
 *  A loop's OWN expression joins its body on the second side: a `while` condition runs once per
 *  iteration, so an advance above the loop and an access in its test are not the same count. A
 *  top-level `if`'s condition stays on the first side, because the `if` statement itself runs once
 *  whatever its arms do. */
function collectSites(body: readonly Stmt[]): { sites: Site[]; nestedAddrs: Set<number> } {
  const sites: Site[] = [];
  const nestedAddrs = new Set<number>();
  const visit = (e: Expr, stmt: number, nested: boolean): void => {
    if (e.k === 'index') {
      const addr = cellAddress(e);
      if (addr !== null) {
        if (nested) {
          nestedAddrs.add(addr);
        } else {
          sites.push({ stmt, addr, width: e.width, signed: e.signed, advanced: e.baseAdvanced });
        }
      }
    }
    mapExprChildren(e, (c) => {
      visit(c, stmt, nested);
      return c;
    });
  };
  const walk = (stmts: readonly Stmt[], stmt: number, nested: boolean): void => {
    for (const s of stmts) {
      const repeats = s.k === 'while' || s.k === 'dowhile' || s.k === 'for';
      for (const e of stmtExprs(s)) {
        visit(e, stmt, nested || repeats);
      }
      walk(stmtChildren(s), stmt, true);
    }
  };
  body.forEach((s, i) => walk([s], i, false));
  return { sites, nestedAddrs };
}

/** The one chain this pass spells, or null. The FIRST advanced site anchors it: a function with two
 *  independent chains gets one candidate spelling the first, which is the conservative half of
 *  "decline over approximate" — a second chain would need its own local and its own placement, and
 *  no corpus row has one. */
function chainOf(sites: readonly Site[], nestedAddrs: ReadonlySet<number>): Site[] | null {
  const occurrences = new Map<number, number>();
  for (const s of sites) {
    occurrences.set(s.addr, (occurrences.get(s.addr) ?? 0) + 1);
  }
  const unique = (s: Site): boolean => occurrences.get(s.addr) === 1 && !nestedAddrs.has(s.addr);
  for (let i = 1; i < sites.length; i++) {
    const head = sites[i - 1];
    if (sites[i].advanced === undefined || !unique(head) || head.advanced !== undefined) {
      continue;
    }
    const chain = [head];
    for (let j = i; j < sites.length; j++) {
      const prev = chain[chain.length - 1];
      const step = sites[j].advanced;
      if (
        step === undefined ||
        !unique(sites[j]) ||
        sites[j].stmt <= prev.stmt ||
        sites[j].width !== prev.width ||
        sites[j].signed !== prev.signed ||
        step <= 0 ||
        step % prev.width !== 0 ||
        prev.addr + step !== sites[j].addr
      ) {
        break;
      }
      chain.push(sites[j]);
    }
    if (chain.length >= 2) {
      return chain;
    }
  }
  return null;
}

/** Re-spell one advanced chain as a pointer local moved in place, or decline (null). */
export function advancedBases(sfn: SFn): SFn | null {
  const { sites, nestedAddrs } = collectSites(sfn.body);
  const chain = chainOf(sites, nestedAddrs);
  if (chain === null) {
    return null;
  }
  const name = nameAllocator(sfn)();
  const elem: IrType = scalarTypeForAccess(chain[0].width, chain[0].signed);
  const ptr: IrType = { kind: 'ptr', to: elem };
  const members = new Set(chain.map((m) => m.addr));
  // The access itself: every chain member reads `*p`, because `p` has been advanced to exactly its
  // address. The evidence fields go with the old base — they described how the ADDRESS was
  // computed, and this spelling is the answer to that question rather than another instance of it.
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    const addr = m.k === 'index' ? cellAddress(m) : null;
    if (m.k === 'index' && addr !== null && members.has(addr)) {
      return { k: 'index', base: { k: 'var', name }, idx: { k: 'const', value: 0 }, width: m.width, signed: m.signed };
    }
    return m;
  };
  const advanceAt = new Map<number, number>();
  for (let i = 1; i < chain.length; i++) {
    advanceAt.set(chain[i].stmt, (chain[i].addr - chain[i - 1].addr) / chain[i].width);
  }
  const body: Stmt[] = [];
  sfn.body.forEach((s, i) => {
    const step = advanceAt.get(i);
    if (step !== undefined) {
      body.push({
        k: 'assign',
        name,
        value: { k: 'bin', op: '+', l: { k: 'var', name }, r: { k: 'const', value: step } },
      });
    }
    body.push(mapStmtExprs(s, rewrite));
  });
  const init: BaseInit = {
    k: 'assign',
    name,
    value: { k: 'cast', to: ptr, e: { k: 'const', value: chain[0].addr } },
  };
  const locals = [...sfn.locals, { name, type: ptr as SFn['locals'][number]['type'] }];
  // `prepend` for `l3/nearbase.ts`'s reason and a second one this pass owns: the init MATERIALISES
  // the register the chain advances, and the target's own instruction order is what says where the
  // pool word was loaded. Putting it in first-use order instead moves it below whatever else the
  // function loads first, which on the row this pass was built for swaps the two pool words and
  // costs the match (measured: variant A vs variant C in test/advance.test.ts's header).
  const { body: placed } = placeBaseLocals({ ...sfn, locals, body }, [init], 'prepend');
  return { ...sfn, locals, body: placed };
}
