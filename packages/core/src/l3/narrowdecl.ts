// L3 stacked variation `/narrow-decl`: a named narrow value declared at its width. `s32 v; v = (u8)(x - 1);`
// becomes `u8 v; v = x - 1;`.
//
// The two spellings compute the same C value at every read. The declaration truncates where the
// cast did, and a `u8`, `s8`, `u16` or `s16` read is promoted to `int`, which is what an `s32` read
// already is. They are not the same program to gcc 2.9's front end. `get_narrower`
// (gcc/tree.c:4516) sees through the promotion of a narrow VARIABLE and not through an `int` that
// a cast was assigned to, so for an unsigned narrow one `shorten_compare` (gcc/c-common.c:1158)
// makes a compare against a constant unsigned and folds `>= 0`, `/` and `%` are shortened to their
// unsigned helpers (gcc/c-typeck.c:2036-2041, :2079-2090), and `>>` becomes a logical shift
// (gcc/c-typeck.c:2119). Without such an operator the object can still differ: `convert_to_integer`
// pushes a narrow store's truncation into an AND's operands (gcc/convert.c:278-284), and a `u8`
// local is a pseudo PROMOTE_MODE already zero-extended (gcc/thumb.h:344, gcc/stmt.c:3318-3323),
// whose low byte is free to read (gcc/expr.c:830-836), where an `s32` one takes a fresh byte pseudo
// and a register copy. Compiled with agbcc `-O2 -mthumb-interwork -fhex-asm -fprologue-bugfix`,
//
//   v = g.c - 1;  h.d = (v & 1) + rnd() % (5 - v) + 1;
//
// copies `v` before the AND under `s32 v` (`mov r1, #1; add r4, r5, #0; and r4, r4, r1`) and
// operates on it in place under `u8 v` (`mov r5, #1; and r5, r5, r4`), which is what
// `kleod:sub_0803E8CC` holds; over `v | 2`, `v ^ 2`, `v + 3` and `v * 3` the two compile alike.
// IDO, KMC gcc and gcc 2.7.2 each emit different code for that pair as well, and every mwcc
// build does for a compare of the narrowed value. Which one the
// source declared is not in the asm, so the differ referees, and the candidate it is derived onto
// stays in the fan.
//
// A STACKED variation (rank-variations.ts), derived onto every other candidate's tree: the width
// of a declaration is orthogonal to every other respell variation, and the row that needs it needs
// it on top of `/offmember`.
//
// REFUSED, each because the two spellings would stop computing the same value:
//   • a local that is not `s32`. A `u32` read is unsigned, and narrowing it would turn its
//     compares, divisions and shifts into signed ones;
//   • a local written more than once, or by `v++`, where a later write could store a value the
//     narrow declaration would truncate;
//   • a local whose one write is not an integer narrowed to a narrower integer, or is a `for`
//     loop's init. A call's operand is not known to be an integer (its callee may return a
//     pointer), so `(u8)f()` is refused too;
//   • a local whose address is taken, or that is volatile, a frame object, uninitialized, or homed
//     in a stack slot. Each of those is an object in memory, whose width is its access width.
import type { IrType } from '../ir/types';
import { type Expr, type SFn, type Stmt, mapStmtLists } from './ast';
import { localMentions } from './mentions';
import { declaredTypes, exprCType } from './typing';

type Narrowing = Extract<Expr, { k: 'cast' }> & { to: Extract<IrType, { kind: 'int' }> };

/** An integer narrowed to a narrower integer. A pointer or a float operand keeps its cast: C converts
 *  neither to an integer by assignment alone. */
const isNarrowing = (e: Expr, env: ReturnType<typeof declaredTypes>): e is Narrowing =>
  e.k === 'cast' && !e.volatile && e.to.kind === 'int' && e.to.width < 32 && exprCType(e.e, env)?.kind === 'int';

/** The tree with every local the header admits declared at its narrowing's width, or null when
 *  none is. */
export function narrowDeclarations(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  const env = declaredTypes(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    const declared = l.type;
    if (
      m === undefined ||
      m.assigns !== 1 ||
      m.addrTaken > 0 ||
      declared.kind !== 'int' ||
      declared.width !== 32 ||
      !declared.signed ||
      l.volatile ||
      l.frame ||
      l.uninit ||
      l.slots
    ) {
      continue;
    }
    let to: IrType | undefined;
    const rewrite = (list: Stmt[]): Stmt[] =>
      list.map((s) => {
        if (s.k === 'assign' && s.name === l.name && isNarrowing(s.value, env)) {
          to = s.value.to;
          return { ...s, value: s.value.e };
        }
        return mapStmtLists(s, rewrite);
      });
    const next = rewrite(body);
    if (to !== undefined) {
      body = next;
      narrowed.set(l.name, to);
    }
  }
  if (narrowed.size === 0) {
    return null;
  }
  return { ...sfn, body, locals: sfn.locals.map((l) => ({ ...l, type: narrowed.get(l.name) ?? l.type })) };
}
