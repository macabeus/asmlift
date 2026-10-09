// L3 stacked variations `/narrow-decl`, `/narrow-load` and `/narrow-read`: a named narrow value
// declared at its width. `/narrow-decl` takes the narrowing cast at the local's one write,
// `/narrow-load` a write that is a narrow memory read, which has no cast to drop, and `/narrow-read`
// the narrowing at every one of its reads:
//
//   s32 v; v = (u8)(x - 1); … v …        becomes   u8 v; v = x - 1; … v …       (/narrow-decl)
//   s32 v; v = p[3]; … v …               becomes   u8 v; v = p[3]; … v …        (/narrow-load)
//   s32 v; v = f(); … (u8)v … (u8)v …    becomes   u8 v; v = f(); … v … v …     (/narrow-read)
//
// The two spellings compute the same C value at every read. The declaration truncates where the
// cast did, or stores a value already of its type, and a `u8`, `s8`, `u16` or `s16` read is
// promoted to `int`, which is what an `s32` read already is. They are not the same program to gcc
// 2.9's front end. `get_narrower` (gcc/tree.c:4516) sees through the promotion of a narrow VARIABLE
// and not through an `int` that a cast was assigned to, so for an unsigned narrow one
// `shorten_compare` (gcc/c-common.c:1158) makes a compare against a constant unsigned and folds
// `>= 0`, `/` and `%` are shortened to their unsigned helpers (gcc/c-typeck.c:2036-2041, :2079-2090),
// and `>>` becomes a logical shift (gcc/c-typeck.c:2119). Without such an operator the object can
// still differ: `convert_to_integer` pushes a narrow store's truncation into an AND's operands
// (gcc/convert.c:278-284), and a `u8` local is a pseudo PROMOTE_MODE already zero-extended
// (gcc/thumb.h:344, gcc/stmt.c:3318-3323), whose low byte is free to read (gcc/expr.c:830-836),
// where an `s32` one takes a fresh byte pseudo and a register copy. Compiled with agbcc
// `-O2 -mthumb-interwork -fhex-asm -fprologue-bugfix`,
//
//   v = g.c - 1;  h.d = (v & 1) + rnd() % (5 - v) + 1;
//
// copies `v` before the AND under `s32 v` (`mov r1, #1; add r4, r5, #0; and r4, r4, r1`) and
// operates on it in place under `u8 v` (`mov r5, #1; and r5, r5, r4`), which is what
// `kleod:sub_0803E8CC` holds; over `v | 2`, `v ^ 2`, `v + 3` and `v * 3` the two compile alike.
// IDO, KMC gcc and gcc 2.7.2 each emit different code for that pair as well, and every mwcc
// build does for a compare of the narrowed value. Which one the
// source declared is not in the asm, so the differ referees, and the candidate it is derived onto
// stays in the fan. A load written to a `u8` local is loaded where it is written, and one written to
// an `s32` local where it is first read (two byte reads held across two calls, compiled in the
// matching suite: `pokeemerald:LoadMonInfo`).
//
// At the reads, `(u8)(s32)e`, `(u8)(u32)e` and `(u8)e` keep the same low byte of any integer `e`,
// so dropping each read's cast keeps its value, whichever write stored it. The pair compiles
// differently by where the extension lands: a `u8` local holding a call's result is zero-extended
// as it is stored, right after the `bl`, where `(u8)v` extends at the read, after whatever ran in
// between (`pokeemerald:RtcGetDayCount`, three results passed on as `u8`s).
//
// Three STACKED variations (rank-variations.ts), derived onto every other candidate's tree: the
// width of a declaration is orthogonal to what every respell variation outside that table changes,
// and the row that needs it needs it on top of `/offmember`. Three, not one, because a function
// holding a local narrowed at its cast write, a local written by a narrow load and a local narrowed
// at its reads may need any combination of the kinds narrowed. Each rewrites every local it admits.
// They do not commute: a cast that is one local's write and another's read is taken by whichever
// runs first, and so is a load-written local whose reads are all narrowed. So every subset of the
// three is its own candidate, and in one holding a write-side member and `/narrow-read` the
// write side runs first and takes the local.
//
// KNOWN GAP, and it is the price of deciding at L3 rather than where the value is named: which
// spelling a call's result had shows only in where its extension lands, right after its `bl` or
// just before its read, and structure/analysis.ts settles that per local when it names the call and
// inlines the extension into the read. So two read-side locals declared differently (`s32 y` cast
// at its read beside `u8 m`) have no candidate, as each entry narrows both or neither; here that
// would take 2^k candidates over k such locals. Nor has `s32 v = (u8)f()` once another such value
// is held across its call, which then compiles like neither spelling; held alone it compiles like
// `u8 v`, which /narrow-read reaches.
//
// REFUSED, each because the two spellings would stop computing the same value or would not build:
//   • a local that is not a 32-bit integer;
//   • a local whose address is taken, or that is volatile, a frame object, uninitialized, or homed
//     in a stack slot. Each of those is an object in memory, whose width is its access width;
//   • a write of a constant that fits neither the signed nor the unsigned type of the narrow width,
//     which gcc warns of when it converts one implicitly (gcc/c-common.c:849-861, :870-895) and a
//     `-Werror` build refuses;
//   • /narrow-decl, /narrow-load: a `u32` local. Its reads stay bare, and a `u32` read is unsigned, so narrowing
//     it would turn its compares, divisions and shifts into signed ones;
//   • /narrow-decl, /narrow-load: a local written more than once, or by `v++`, where a later write
//     could store a value the narrow declaration would truncate and a bare read would not;
//   • /narrow-decl: a local whose one write is a `for` loop's init, or that is not an integer
//     narrowed to a narrower integer. A call's operand is not known to be an integer (its callee
//     may return a pointer), so `(u8)f()` is refused too;
//   • /narrow-load: a local whose one write is a `for` loop's init, or is no `p[i]` or member read
//     of a narrower integer type. A narrow variable (`v = a1` of a `u8 a1`) is refused: no row has
//     needed it;
//   • /narrow-read: a read that is not a narrowing cast (a bare `v`, an index base, a `v++`), reads
//     cast to two widths or two signednesses, a write in a `for` loop's init or step, and a write
//     whose value is a pointer, a float or of no known type. A call is admitted: its value already
//     converts implicitly to the 32-bit local, and narrowing changes only the width of that
//     conversion, never whether C performs one. A `u32` local and one written more than once are
//     admitted, because every read already narrows each value stored to the one width.
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

/** The narrower integer type a memory read (`p[i]`, `*p`, a member) already has, which a local it is
 *  assigned to may be declared at with nothing to drop. */
const narrowLoad = (e: Expr, env: ReturnType<typeof declaredTypes>): Narrowing['to'] | undefined => {
  if (e.k !== 'index' && e.k !== 'field') {
    return undefined;
  }
  const t = exprCType(e, env);
  return t?.kind === 'int' && t.width < 32 ? (t as Narrowing['to']) : undefined;
};

/** `(T)v`, the read of `name` narrowed to the narrower integer T. */
const isReadNarrowing = (e: Expr, name: string): e is Narrowing =>
  e.k === 'cast' && !e.volatile && e.to.kind === 'int' && e.to.width < 32 && e.e.k === 'var' && e.e.name === name;

/** The one type every read of `name` is narrowed to, or undefined when a read is not narrowed
 *  or two reads are narrowed differently. `reads` counts every read however spelled, so a read
 *  that is not a narrowing leaves the count short. */
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

/** The value of every assignment statement to `name`, found the way the write-side rewrite finds
 *  them: through statement lists, so a `for` init or step is not one. */
function writtenValues(body: Stmt[], name: string): Expr[] {
  const values: Expr[] = [];
  const walk = (list: Stmt[]): void => {
    for (const s of list) {
      if (s.k === 'assign' && s.name === name) {
        values.push(s.value);
      }
      stmtLists(s).forEach(walk);
    }
  };
  walk(body);
  return values;
}

/** `body` with every `(T)name` read spelled `name`. */
const dropReadCasts = (body: Stmt[], name: string): Stmt[] => {
  const expr = (e: Expr): Expr => (isReadNarrowing(e, name) ? e.e : mapExprChildren(e, expr));
  return body.map((s) => mapStmtExprs(s, expr));
};

/** The local's admission common to both sides: a 32-bit integer in no memory. */
const admissible = (l: SFn['locals'][number], m: Mentions | undefined): m is Mentions =>
  m !== undefined &&
  m.addrTaken === 0 &&
  l.type.kind === 'int' &&
  l.type.width === 32 &&
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

/** What a write-side variation makes of a local's one write: the narrow type to declare the local
 *  at and the value to store, or undefined when it does not take that write. */
type WriteNarrowing = (
  value: Expr,
  env: ReturnType<typeof declaredTypes>,
) => { to: Narrowing['to']; value: Expr } | undefined;

/** A narrowing cast, dropped. */
const castWrite: WriteNarrowing = (value, env) =>
  isNarrowing(value, env) && storesQuietly(value.e, value.to) ? { to: value.to, value: value.e } : undefined;

/** A narrow memory read, kept as written. */
const loadWrite: WriteNarrowing = (value, env) => {
  const to = narrowLoad(value, env);
  return to === undefined ? undefined : { to, value };
};

/** The tree with every admitted local whose one write `take` takes narrowed at that write, or null
 *  when none is. */
function narrowAtWrite(sfn: SFn, take: WriteNarrowing): SFn | null {
  const mentions = localMentions(sfn);
  const env = declaredTypes(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    if (!admissible(l, m) || m.assigns !== 1 || l.type.kind !== 'int' || !l.type.signed) {
      continue;
    }
    let to: IrType | undefined;
    const rewrite = (list: Stmt[]): Stmt[] =>
      list.map((s) => {
        const taken = s.k === 'assign' && s.name === l.name ? take(s.value, env) : undefined;
        if (taken !== undefined) {
          to = taken.to;
          return { ...s, value: taken.value };
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

/** `/narrow-decl`: the tree with every admitted local narrowed at its cast write, or null when none is. */
export const narrowDeclarations = (sfn: SFn): SFn | null => narrowAtWrite(sfn, castWrite);

/** `/narrow-load`: the tree with every admitted local written by a narrow memory read declared at that
 *  read's type, or null when none is. */
export const narrowLoadDeclarations = (sfn: SFn): SFn | null => narrowAtWrite(sfn, loadWrite);

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
    const written = writtenValues(body, l.name);
    if (written.length !== m.assigns || written.some((w) => w.k !== 'call' && exprCType(w, env)?.kind !== 'int')) {
      continue;
    }
    const read = readNarrowing(body, l.name, readsOf(m));
    if (read !== undefined && written.every((w) => storesQuietly(w, read))) {
      body = dropReadCasts(body, l.name);
      narrowed.set(l.name, read);
    }
  }
  return declared(sfn, body, narrowed);
}
