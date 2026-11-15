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
// STACKED variations (rank-variations.ts), derived onto every other candidate's tree: the
// width of a declaration is orthogonal to what every respell variation outside that table changes,
// and the row that needs it needs it on top of `/offmember`. Three, not one, because a function
// holding a local narrowed at its cast write, a local written by a narrow load and a local narrowed
// at its reads may need any combination of the kinds narrowed. Each rewrites every local it admits.
// They do not commute: a cast that is one local's write and another's read is taken by whichever
// runs first, and so is a load-written local whose reads are all narrowed. So every subset of the
// three is its own candidate, and in one holding `/narrow-decl` or `/narrow-load` and `/narrow-read`
// the write side runs first and takes the local. `/narrow-range` (below) runs after all three, so a
// local it shares with `/narrow-read` is `/narrow-read`'s in a candidate holding both.
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
//   • /narrow-decl, /narrow-load: a `u32` local. Its reads stay bare, and a `u32` read is unsigned,
//     so narrowing it would turn its compares, divisions and shifts into signed ones;
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
import { declaredWidth } from '../proto';
import {
  type BinOp,
  type Expr,
  type SFn,
  type Stmt,
  assignsIn,
  exprChildren,
  mapExprChildren,
  mapStmtExprs,
  mapStmtLists,
  stmtChildren,
  stmtExprs,
  stmtLists,
  walkExprs,
} from './ast';
import { type Mentions, localMentions, readsOf } from './mentions';
import {
  INT_RESULT_BINOPS,
  declaredTypes,
  exprCType,
  renderedIntSignedness,
  signedOverUnsignedCompare,
} from './typing';

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

/** `body` with every `(T)name` read spelled `name`, of one T when `only` names it. */
const dropReadCasts = (body: Stmt[], name: string, only?: Narrowing['to']): Stmt[] => {
  const drops = (e: Expr): e is Narrowing =>
    isReadNarrowing(e, name) && (only === undefined || (e.to.width === only.width && e.to.signed === only.signed));
  const expr = (e: Expr): Expr => (drops(e) ? e.e : mapExprChildren(e, expr));
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

/** A local the write-side members consider: admitted, signed, and written once. */
const writtenOnce = (l: SFn['locals'][number], m: Mentions | undefined): m is Mentions =>
  admissible(l, m) && m.assigns === 1 && l.type.kind === 'int' && l.type.signed;

/** The tree with every admitted local whose one write `take` takes narrowed at that write, or null
 *  when none is. */
function narrowAtWrite(sfn: SFn, take: WriteNarrowing): SFn | null {
  const mentions = localMentions(sfn);
  const env = declaredTypes(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    if (!writtenOnce(l, m)) {
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

// ---------------------------------------------------------------------------------------------
// `/narrow-range`: a local EVERY write of which already stores a value of one narrow type, declared
// at that type, however many writes it has. The shape is a narrow loop counter, which the lift
// spells as a 32-bit local stepped through a cast:
//
//   u32 v; v = 0; do { … v … v = (u16)(v + 1); } while (v < n);
//   becomes   u16 v; v = 0; do { … v … v = v + 1; } while (v < n);
//
// THE SAME VALUE AT EVERY READ. Each write is a narrowing cast to T, or a literal in T's range, or
// an integer that already has a type no wider than T and of a sign T holds, so the local holds a
// value of T at every point the 32-bit spelling reads it (it is never read uninitialized: an
// `uninit` local is refused). Declared T, each write converts to T exactly where the cast did, and
// a read is that value promoted to `int`.
//   • Over an `s32` local that is the whole argument: a read was an `int` and still is.
//   • Over a `u32` local a read was `unsigned` and becomes `int` of the same value. T must then be
//     unsigned (a signed T stored in a `u32` holds 2^32 + v for a negative v, which no narrow T
//     reads back). The read itself converts to the same value anywhere, but an expression built on
//     it may change type: `v - 1` was `unsigned` and is now `int`, the same 32 bits. Bits are all
//     `+`, `-`, `*`, `&`, `|`, `^`, `~`, `<<`, a cast to an integer of at most 32 bits, an index, an
//     equality and a truth test read, and the C-family printer pins `/`, `%` and `>>` to the
//     signedness their op carries (backend/cfamily.ts). An ordered compare is judged on the whole
//     tree after the rewrite (typing.ts `signedOverUnsignedCompare`). Every other consumer of an
//     expression whose type changed refuses the local: a call argument the declared callee does not
//     type as an integer or a pointer, a cast to a wider or a float type, a store to a lvalue whose
//     type is unknown, a member base.
//
// A read the 32-bit spelling cast to T (`(u8)v`) is the bare read once `v` is declared T, and is
// spelled bare: `(T)v` and `v` are the same `int` of the same T value.
//
// THE CODEGEN FACT. agbcc allocates the two spellings differently. In `pokeemerald:StringCopyN`
// (a byte copy indexed by a counter, against a `u8` bound) both keep the counter an index
// (`add`, `ldrb`, `strb`); under `u16 v` the bound is held in one more callee-saved register and
// copied twice more (`add r0, r5, #0`) where `u32 v` compares it in place, so the lifted body
// compiles 16 normalized lines away from its source and the same body with ONLY the counter
// declared `u16` identically. Which width the source
// declared is not in the asm where the two compile alike, so the differ referees: a STACKED
// variation beside the other widths.
//
// REACH. The counters this takes are the ones whose step the lift spells as a narrowing cast at the
// write: agbcc's and IDO's cast-stepped counters (55 and 7 bench rows fire it). An IDO step spelled
// as a mask (`v = v + 1 & 255`) is not an in-range write it admits, and mwcc, kmc and gcc 2.7.2
// truncate at the read (`(s16)v`, `v << 16 >> 16`), which `/narrow-read` and not this variation
// would take. Neither is built: declared at the source's width, IDO's `brmerge` and `thrbreak`
// score no closer (31 -> 31, 29 -> 30 normalized lines), so no row shows the gain.
//
// REFUSED, beyond `admissible` (no memory, no address, 32-bit integer, initialized):
//   • a local `/narrow-decl` or `/narrow-load` takes (a signed one with one write they narrow),
//     which offering here too would derive the same tree twice. With WIDTH_CHOICES crossing this
//     variation only alone and beside `/narrow-read` (rank-variations.ts), the consequence is that
//     no candidate narrows such a local AND a counter only this variation takes: a function
//     holding both (`s32 v1 = (u8)(a0 - 1)` beside a `(u8)`-stepped `u32 v0`) is offered
//     `u8 v1; u32 v0` and `s32 v1; u8 v0`, never `u8 v1; u8 v0`. No bench winner needs it (0 of
//     the 50 holding `/narrow-range` hold `/narrow-decl` or `/narrow-load`); a row that does is
//     what would earn taking that local here when this variation also takes one of its own;
//   • a `v++` or `v--`, which steps the local past T's range in the 32-bit spelling;
//   • a write that is not one of the three in-range forms above, or two writes of different narrow
//     types (a `(u8)` beside a `(u16)` would need the wider type, which no write states);
//   • a `u32` local narrowed to a signed type, and a `u32` local one of whose reads feeds an
//     expression whose type changes into a consumer listed above;
//   • a rewrite after which some unsigned compare reads signed.

/** The narrow type a write stores a value of, and the value it stores declared at that type, or
 *  undefined when the write is not known to store a value of one narrow type. A cast's own value is
 *  in range, a literal is when T holds it, and so is an integer whose own type is no wider. */
type InRange = { to: Narrowing['to'] | undefined; value: Expr; fits: (t: Narrowing['to']) => boolean };

const holds = (t: Narrowing['to'], c: number): boolean =>
  t.signed ? c >= -(2 ** (t.width - 1)) && c < 2 ** (t.width - 1) : c >= 0 && c < 2 ** t.width;

/** Whether every value of integer type `from` is a value of `to`. */
const within = (from: Narrowing['to'], to: Narrowing['to']): boolean =>
  from.signed === to.signed ? from.width <= to.width : !from.signed && to.signed && from.width < to.width;

function inRange(value: Expr, env: ReturnType<typeof declaredTypes>): InRange | undefined {
  const cast = castWrite(value, env);
  if (cast !== undefined) {
    return { to: cast.to, value: cast.value, fits: (t) => t.width === cast.to.width && t.signed === cast.to.signed };
  }
  if (value.k === 'const') {
    return { to: undefined, value, fits: (t) => holds(t, value.value) };
  }
  const t = value.k === 'call' ? undefined : exprCType(value, env);
  if (t?.kind === 'int' && t.width < 32) {
    const from = t as Narrowing['to'];
    return { to: undefined, value, fits: (to) => within(from, to) };
  }
  return undefined;
}

/** `body` with each write to `name` storing `rewrite`'s value, `for` heads included. */
function rewriteWrites(body: Stmt[], name: string, rewrite: (value: Expr) => Expr): Stmt[] {
  const stmt = (s: Stmt): Stmt => {
    const own = s.k === 'assign' && s.name === name ? { ...s, value: rewrite(s.value) } : s;
    const nested = mapStmtLists(own, (list) => list.map(stmt));
    return nested.k === 'for' ? { ...nested, init: stmt(nested.init), inc: stmt(nested.inc) } : nested;
  };
  return body.map(stmt);
}

/** Binary operators whose 32-bit result bits do not depend on their operands' signedness. */
const BIT_OPS: ReadonlySet<BinOp> = new Set<BinOp>(['+', '-', '*', '&', '|', '^', '<<']);
/** Operators that read their operands' bits only: the integer compares and connectives (an ordered
 *  one is judged after the rewrite, `signedOverUnsignedCompare`), and those whose printer pins the
 *  signedness the op carries (`/`, `%`, `>>` and their unsigned twins), so an operand of changed
 *  type means the same. A float compare converts its operands by value and is not one. */
const BIT_READERS: ReadonlySet<BinOp> = new Set<BinOp>([
  ...[...INT_RESULT_BINOPS].filter((op) => !op.startsWith('f')),
  '/',
  '/u',
  '%',
  '%u',
  '>>',
  '>>>',
]);

/** Whether an integer or pointer type a value converts into keeps its 32 bits. */
const bitSink = (t: IrType | undefined): boolean =>
  t !== undefined && (t.kind === 'ptr' || (t.kind === 'int' && t.width <= 32));

/** A declared parameter spelling that is an integer or a pointer of at most 32 bits. A float
 *  spelling never arrives: target.ts `declaredArgTypes` keeps only what `declaredWidth` sizes. */
const bitParam = (spelled: string | undefined): boolean => {
  const w = spelled === undefined ? undefined : declaredWidth(spelled);
  return w !== undefined && w <= 32;
};

/** Whether every expression whose C type `changed` reports is read only where its bits are all that
 *  matter. `changed` is asked of every node; an unchanged node bounds what its children did. */
function changedTypesStayBits(sfn: SFn, changed: (e: Expr) => boolean, env: ReturnType<typeof declaredTypes>): boolean {
  let ok = true;
  /** `e` in a position whose consumer `sink` is: 'bits' reads its bits, 'value' its typed value. */
  const visit = (e: Expr, sink: 'bits' | 'value'): void => {
    if (!ok) {
      return;
    }
    if (sink === 'value' && changed(e)) {
      ok = false;
      return;
    }
    switch (e.k) {
      case 'bin':
        // a bit operator's result was refused above if its consumer reads a changed type, and is
        // otherwise the same bits of the same type, so its operands' bits are all it reads
        if (BIT_OPS.has(e.op) || BIT_READERS.has(e.op)) {
          visit(e.l, 'bits');
          visit(e.r, 'bits');
          return;
        }
        visit(e.l, 'value');
        visit(e.r, 'value');
        return;
      case 'un':
        visit(e.e, e.op === 'f-' ? 'value' : 'bits');
        return;
      case 'cast':
        visit(e.e, bitSink(e.to) ? 'bits' : 'value');
        return;
      case 'index':
        visit(e.base, 'bits');
        (e.lead ?? []).forEach((l) => visit(l, 'bits'));
        visit(e.idx, 'bits');
        return;
      case 'call': {
        if (typeof e.fn !== 'string') {
          visit(e.fn, 'bits');
        }
        const declared = typeof e.fn === 'string' ? sfn.declaredArgs?.[e.fn] : undefined;
        e.args.forEach((a, i) => visit(a, !e.wide64 && bitParam(declared?.[i]) ? 'bits' : 'value'));
        return;
      }
      default:
        exprChildren(e).forEach((c) => visit(c, 'value'));
    }
  };
  const stmt = (s: Stmt): void => {
    switch (s.k) {
      case 'assign':
        visit(s.value, bitSink(env(s.name)) ? 'bits' : 'value');
        break;
      case 'store':
        visit(s.lval, 'bits');
        visit(s.value, bitSink(exprCType(s.lval, env)) ? 'bits' : 'value');
        break;
      case 'return':
        if (s.value) {
          visit(s.value, bitSink(sfn.retType) ? 'bits' : 'value');
        }
        break;
      default:
        stmtExprs(s).forEach((e) => visit(e, 'bits'));
    }
    stmtChildren(s).forEach(stmt);
  };
  sfn.body.forEach(stmt);
  return ok;
}

/** `/narrow-range`: the tree with every admitted local whose every write stores a value of one
 *  narrow integer type declared at that type, the narrowing casts of its writes dropped, or null
 *  when none is. */
export function narrowRangeDeclarations(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  let cur = sfn;
  let any = false;
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    if (!admissible(l, m) || l.type.kind !== 'int') {
      continue;
    }
    const env = declaredTypes(cur);
    if (
      writtenOnce(l, m) &&
      writtenValues(cur.body, l.name).some((w) => castWrite(w, env) !== undefined || loadWrite(w, env) !== undefined)
    ) {
      continue;
    }
    const writes = assignsIn(cur.body).filter((a) => a.name === l.name);
    // a `v++` is counted by `assigns` and is no assignment statement
    if (writes.length !== m.assigns) {
      continue;
    }
    const ranges = writes.map((w) => inRange(w.value, env));
    if (ranges.some((r) => r === undefined)) {
      continue;
    }
    const stated = ranges.map((r) => r!.to).filter((t): t is Narrowing['to'] => t !== undefined);
    const to = stated[0];
    if (to === undefined || !ranges.every((r) => r!.fits(to)) || (!l.type.signed && to.signed)) {
      continue;
    }
    const narrowedWrites = new Map(writes.map((w, i) => [w.value, ranges[i]!.value]));
    const written = rewriteWrites(cur.body, l.name, (v) => narrowedWrites.get(v) ?? v);
    const body = dropReadCasts(written, l.name, to);
    const next: SFn = { ...cur, body, locals: cur.locals.map((x) => (x.name === l.name ? { ...x, type: to } : x)) };
    if (!l.type.signed) {
      const before = env;
      const after = declaredTypes(next);
      // the read itself is the same non-negative value wherever it converts to; what can differ is
      // an expression built on it, whose type it changed
      const changed = (e: Expr): boolean =>
        e.k !== 'var' && renderedIntSignedness(e, before) === false && renderedIntSignedness(e, after) !== false;
      if (!changedTypesStayBits(next, changed, after)) {
        continue;
      }
    }
    if (signedOverUnsignedCompare(next) && !signedOverUnsignedCompare(cur)) {
      continue;
    }
    cur = next;
    any = true;
  }
  return any ? cur : null;
}
