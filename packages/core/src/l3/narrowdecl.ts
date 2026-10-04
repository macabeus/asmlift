// L3 stacked variations `/narrow-decl` and `/narrow-read`: a named narrow value declared at its
// width. `/narrow-decl` takes the narrowing at the local's one write, `/narrow-read` at every one of
// its reads:
//
//   s32 v; v = (u8)(x - 1); … v …        becomes   u8 v; v = x - 1; … v …       (/narrow-decl)
//   s32 v; v = f(); … (u8)v … (u8)v …    becomes   u8 v; v = f(); … v … v …     (/narrow-read)
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
// At the reads, `(u8)(s32)e` and `(u8)e` keep the same low byte of any integer `e`, so dropping
// each read's cast keeps its value. The pair compiles differently by where the extension lands: a
// `u8` local holding a call's result is zero-extended as it is stored, right after the `bl`, where
// `(u8)v` extends at the read, after whatever ran in between (`pokeemerald:RtcGetDayCount`, three
// results passed on as `u8`s).
//
// Two STACKED variations (rank-variations.ts), derived onto every other candidate's tree: the width
// of a declaration is orthogonal to every other respell variation, and the row that needs it needs
// it on top of `/offmember`. Two, not one, because which locals the source declared narrow is per
// local: a function holding a local of each kind may need either one narrowed alone. Each rewrites
// every local it admits; in the all-together candidate `/narrow-decl` runs first, so a cast that is
// both one local's write and another's read is taken as the write.
//
// REFUSED, each because the two spellings would stop computing the same value or would not build:
//   • a local that is not `s32`. A `u32` read is unsigned, and narrowing it would turn its
//     compares, divisions and shifts into signed ones;
//   • a local written more than once, or by `v++`, where a later write could store a value the
//     narrow declaration would truncate;
//   • a local whose one write is a `for` loop's init;
//   • a local whose address is taken, or that is volatile, a frame object, uninitialized, or homed
//     in a stack slot. Each of those is an object in memory, whose width is its access width;
//   • a write of a constant that fits neither the signed nor the unsigned type of the narrow width,
//     which gcc warns of when it converts one implicitly (gcc/c-common.c:849-861, :870-895) and a
//     `-Werror` build refuses;
//   • /narrow-decl: a write that is not an integer narrowed to a narrower integer. A call's
//     operand is not known to be an integer (its callee may return a pointer), so `(u8)f()` is
//     refused too;
//   • /narrow-read: a read that is not a narrowing cast (a bare `v`, an index base), reads cast to
//     two widths or two signednesses, and a write whose value is a pointer, a float or of no known
//     type. A call is admitted: its value already converts implicitly to the `s32`, and narrowing
//     changes only the width of that conversion, never whether C performs one.
import type { IrType } from '../ir/types';
import {
  type Expr,
  type SFn,
  type Stmt,
  mapExprChildren,
  mapStmtExprs,
  mapStmtLists,
  stmtLists,
  walkExprs,
} from './ast';
import { type Mentions, localMentions, readsOf } from './mentions';
import { declaredTypes, exprCType } from './typing';

type Narrowing = Extract<Expr, { k: 'cast' }> & { to: Extract<IrType, { kind: 'int' }> };

/** An integer narrowed to a narrower integer. A pointer or a float operand keeps its cast: C converts
 *  neither to an integer by assignment alone. */
const isNarrowing = (e: Expr, env: ReturnType<typeof declaredTypes>): e is Narrowing =>
  e.k === 'cast' && !e.volatile && e.to.kind === 'int' && e.to.width < 32 && exprCType(e.e, env)?.kind === 'int';

/** `(T)v`, the read of `name` narrowed to the narrower integer T. */
const isReadNarrowing = (e: Expr, name: string): e is Narrowing =>
  e.k === 'cast' && !e.volatile && e.to.kind === 'int' && e.to.width < 32 && e.e.k === 'var' && e.e.name === name;

/** The one type every read of `name` is narrowed to, or undefined when a read is not narrowed
 *  or two reads are narrowed differently. `reads` counts every read however spelled, so a read
 *  this walk does not see as a narrowing is a shortfall rather than a miss. */
function readNarrowing(body: Stmt[], name: string, reads: number): Narrowing['to'] | undefined {
  let to: Narrowing['to'] | undefined;
  let narrowed = 0;
  for (const e of walkExprs(body)) {
    if (!isReadNarrowing(e, name)) {
      continue;
    }
    if (to !== undefined && (to.width !== e.to.width || to.signed !== e.to.signed)) {
      return undefined;
    }
    to = e.to;
    narrowed++;
  }
  return narrowed === reads ? to : undefined;
}

/** The value of `name`'s one assignment statement, found the way the write-side rewrite finds it:
 *  through statement lists, so a `for` init is not one. */
function writtenValue(body: Stmt[], name: string): Expr | undefined {
  for (const s of body) {
    if (s.k === 'assign' && s.name === name) {
      return s.value;
    }
    for (const list of stmtLists(s)) {
      const v = writtenValue(list, name);
      if (v !== undefined) {
        return v;
      }
    }
  }
  return undefined;
}

/** `body` with every `(T)name` read spelled `name`. */
const dropReadCasts = (body: Stmt[], name: string): Stmt[] => {
  const expr = (e: Expr): Expr => (isReadNarrowing(e, name) ? e.e : mapExprChildren(e, expr));
  return body.map((s) => mapStmtExprs(s, expr));
};

/** The local's admission common to both sides: an `s32`, written once, in no memory. */
const admissible = (l: SFn['locals'][number], m: Mentions | undefined): m is Mentions =>
  m !== undefined &&
  m.assigns === 1 &&
  m.addrTaken === 0 &&
  l.type.kind === 'int' &&
  l.type.width === 32 &&
  l.type.signed &&
  !l.volatile &&
  !l.frame &&
  !l.uninit &&
  !l.slots;

/** Whether storing `value` into an `int` of `to`'s width converts without gcc's constant warning: a
 *  constant must fit the signed or the unsigned type of that width. */
const storesQuietly = (value: Expr, to: Narrowing['to']): boolean =>
  value.k !== 'const' || (value.value >= -(2 ** (to.width - 1)) && value.value < 2 ** to.width);

/** `sfn` with each local in `narrowed` declared at its width, or null when it is empty. */
const declared = (sfn: SFn, body: Stmt[], narrowed: Map<string, IrType>): SFn | null =>
  narrowed.size === 0
    ? null
    : { ...sfn, body, locals: sfn.locals.map((l) => ({ ...l, type: narrowed.get(l.name) ?? l.type })) };

/** `/narrow-decl`: the tree with every admitted local narrowed at its write, or null when none is. */
export function narrowDeclarations(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  const env = declaredTypes(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    if (!admissible(l, mentions.get(l.name))) {
      continue;
    }
    let to: IrType | undefined;
    const rewrite = (list: Stmt[]): Stmt[] =>
      list.map((s) => {
        if (
          s.k === 'assign' &&
          s.name === l.name &&
          isNarrowing(s.value, env) &&
          storesQuietly(s.value.e, s.value.to)
        ) {
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
  return declared(sfn, body, narrowed);
}

/** `/narrow-read`: the tree with every admitted local narrowed at its reads, or null when none is. */
export function narrowReadDeclarations(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  const env = declaredTypes(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    if (!admissible(l, m)) {
      continue;
    }
    const written = writtenValue(body, l.name);
    if (written === undefined || (written.k !== 'call' && exprCType(written, env)?.kind !== 'int')) {
      continue;
    }
    const read = readNarrowing(body, l.name, readsOf(m));
    if (read !== undefined && storesQuietly(written, read)) {
      body = dropReadCasts(body, l.name);
      narrowed.set(l.name, read);
    }
  }
  return declared(sfn, body, narrowed);
}
