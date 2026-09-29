// asmlift — the C DEFINITION of each function-scope static a function names (ir/core.ts
// `LocalObjects`), typed from the target's own definition and the accesses the function makes.
//
// The frontend hands over what the target shows: section, size and bytes, and where the target is
// an assembler listing (agbcc's `.s`) the definition's directives too. Those say the element: the
// compiler writes each scalar of the initializer with the directive of its width, so a table of
// `.short`s is one of 16-bit elements whatever the function reads out of it, and a narrow negative
// value is only ever written for a signed type. An object file (mwcc) shows no directives, and
// there the element is the one width every access agrees on. The loads of the element's width then
// settle its signedness — they are what the function computes, and a byte holds the same bits
// declared either way, so they outrank a negative the source wrote through another type (a struct's
// signed field, a cast) — and the definition settles it where no load does. An object nothing says
// anything about is bytes.
//
// The target also shows the ALIGNMENT — the listing's `.align`, mwcc's `.comment` record — which
// decides where the object lands after the statics declared before it, and whether a DMA or GX
// buffer is where the hardware needs it. The definition this pass picks gets its compiler's own
// alignment, which the target declares ({@link StaticLayout}): a scalar to its width, an array to
// its element or the compiler's aggregate floor, a string literal to the compiler's string
// alignment. A target aligned wider — a struct, an `s64`, an `ALIGNED(32)` — keeps that alignment
// in an attribute, because a table one element off is misread by the machine and scored as a
// MATCH. A byte array the listing wrote as strings and placed at the string alignment is spelled
// with a string literal, which is what gives it that alignment.
//
// The definition is a SymbolInfo as well as a declaration, because the structurer spells an access
// through a symbol's declared shape (`tide[i]` for an array, the bare `q` for a scalar): the shape
// it spells against and the object the backend defines are one reading of the same facts. Both are
// keyed by the LINKER name the IR carries (`tide.3`), and the finished tree is renamed to the
// source's (`tide`) in one step, `nameLocalStatics`, which is where a clash between that name and
// anything else the function names can first be seen whole.
//
// REFUSES, naming the static, when the target's compiler declares no layout rules, when nothing
// in the definition settles the width and the accesses disagree on it, when the width is no
// integer type's or does not divide the size, when the loads disagree on the signedness, when the
// definition is aligned narrower than its declaration here would be, when a bss static's offset
// says it was initialized to zero and it is no scalar (or the input does not show the offset);
// and, at the rename, when two statics share a source name (one block cannot declare both) or when
// the function names anything else by it — a global, a callee, a parameter, a local, itself —
// which the block-scope static would hide.
import { type Fn, type LocalObject, type LocalObjects, type Op, type Value, defOpMap } from '../ir/core';
import { type IrType, T } from '../ir/types';
import {
  type Expr,
  type SFn,
  type SStatic,
  type Stmt,
  mapExprChildren,
  mapStmtExprs,
  mapStmtLists,
  walkExprs,
} from '../l3/ast';
import { takenNames } from '../l3/hoist';
import { type SymbolInfo, accessSignedness } from '../symbols';

/** How a compiler lays out a function-scope static — facts about the COMPILER, declared per target
 *  (target.ts `compilerBehaviors.staticLayout`), from which the definition that puts a static where
 *  the target has it follows. */
export interface StaticLayout {
  /** the least alignment it gives an array or a struct, whatever the element */
  aggregateAlign: number;
  /** the alignment it gives a declaration initialized by a string literal */
  stringAlign: number;
  /** where a scalar initialized to zero goes: kept in `.data`, or moved to bss — where its
   *  initializer is gone, and one element of zero in `.data` must then have been an aggregate. A
   *  compiler that moves them lays them out ahead of the statics with no initializer, in
   *  declaration order, and those after them in reverse (mwcc: `a = 0; b; c = 0;` at +0, +8, +4),
   *  so the offsets say which of a function's bss statics had the `= 0`. */
  zeroScalar: 'data' | 'bss';
}

/** The bss statics of `objs` that were initialized to zero, on a compiler that moves them there
 *  ({@link StaticLayout.zeroScalar}), or the symbol of one whose offset the input does not show.
 *  Within one section a function's zero-initialized statics come first with their counters rising,
 *  the others after with their counters falling; so a static with a later-declared one at a higher
 *  offset had the initializer. The last of the rising run cannot be told from the first of the
 *  falling one, and both declarations put it in the same place: it is left without. */
function zeroInitialized(objs: readonly LocalObject[]): Set<string> | { symbol: string } {
  const out = new Set<string>();
  const bss = objs.filter((o) => o.section === 'bss');
  for (const o of bss) {
    if (o.placement === undefined) {
      return { symbol: o.symbol };
    }
  }
  for (const o of bss) {
    const at = o.placement!;
    if (bss.some((p) => p.placement!.section === at.section && p.placement!.offset > at.offset && p.order > o.order)) {
      out.add(o.symbol);
    }
  }
  return out;
}

/** Each static's shape for the structurer, and its definition for the backend. */
export interface LocalStaticShapes {
  infos: Map<string, SymbolInfo>;
  statics: SStatic[];
}

/** One access through a static's address: the width it reads or writes, and a load's extension. */
interface Access {
  width: number;
  signed?: boolean;
}

/** The width an `aload`/`astore` reads or writes. Its `elemSize` is the element's, which for an
 *  element of a struct array (raise/struct-arrays.ts, `fieldOff`) is the STRIDE: the access itself
 *  is the field's, whose type the base's struct carries. Null for a field that type does not hold. */
function indexedWidth(op: Op): number | null {
  const fieldOff = op.attrs.fieldOff as number | undefined;
  if (fieldOff === undefined) {
    return op.attrs.elemSize as number;
  }
  const bt = op.operands[0].type;
  const field = bt.kind === 'ptr' && bt.to.kind === 'struct' ? bt.to.fields.find((f) => f.off === fieldOff) : undefined;
  return field !== undefined && field.type.kind === 'int' ? field.type.width / 8 : null;
}

/** Every access through each static's address. */
function accessesOf(fn: Fn, names: ReadonlySet<string>): Map<string, Access[]> {
  const defs = defOpMap(fn);
  /** the static an address is computed from — its `gaddr`, through adds of anything else */
  const baseOf = (v: Value, seen = new Set<Value>()): string | null => {
    const d = defs.get(v);
    if (d === undefined || seen.has(v)) {
      return null;
    }
    seen.add(v);
    if (d.opcode === 'gaddr') {
      return names.has(d.attrs.sym as string) ? (d.attrs.sym as string) : null;
    }
    if (d.opcode === 'add' || d.opcode === 'sub') {
      const found = d.operands.slice(0, d.opcode === 'sub' ? 1 : undefined).map((o) => baseOf(o, seen));
      const hits = found.filter((f): f is string => f !== null);
      return hits.length === 1 ? hits[0] : null;
    }
    return null;
  };
  const out = new Map<string, Access[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const plain = op.opcode === 'load' || op.opcode === 'store';
      const indexed = op.opcode === 'aload' || op.opcode === 'astore';
      if (!plain && !indexed) {
        continue;
      }
      const sym = baseOf(op.operands[0]);
      if (sym === null) {
        continue;
      }
      const width = plain ? (op.attrs.width as number) : indexedWidth(op);
      if (width === null) {
        continue;
      }
      const isLoad = op.opcode === 'load' || op.opcode === 'aload';
      const list = out.get(sym) ?? out.set(sym, []).get(sym)!;
      list.push({
        width,
        ...(isLoad ? { signed: accessSignedness(width, op.attrs.signed as boolean | undefined) } : {}),
      });
    }
  }
  return out;
}

/** The elements of `obj`'s initial bytes read `width` bytes at a time in its byte order. */
function elements(obj: LocalObject, width: number, signed: boolean): number[] {
  const b = obj.bytes!;
  const out: number[] = [];
  for (let at = 0; at < obj.size; at += width) {
    let v = 0;
    for (let i = 0; i < width; i++) {
      v = v * 256 + b[obj.bigEndian ? at + i : at + width - 1 - i];
    }
    out.push(signed && v >= 2 ** (8 * width - 1) ? v - 2 ** (8 * width) : v);
  }
  return out;
}

/** The shape and definition of every static `fn` defines, or the refusal: the static's linker name
 *  and the tail of the sentence. */
export function localStaticShapes(
  fn: Fn,
  layout: StaticLayout | undefined,
): LocalStaticShapes | { symbol: string; refused: string } {
  const objs = fn.localObjects;
  const infos = new Map<string, SymbolInfo>();
  const statics: SStatic[] = [];
  if (objs === undefined) {
    return { infos, statics };
  }
  if (layout === undefined) {
    const [first] = objs.keys();
    return { symbol: first, refused: "whose layout rules this target's compiler does not declare" };
  }
  const access = accessesOf(fn, new Set(objs.keys()));
  const zeroed = layout.zeroScalar === 'bss' ? zeroInitialized([...objs.values()]) : new Set<string>();
  if (!(zeroed instanceof Set)) {
    return { symbol: zeroed.symbol, refused: 'in bss at an offset this input does not show' };
  }
  // Declared in the target's declaration order, which the compiler lays the objects out by (mwcc
  // reverses it for bss statics with no initializer): the candidate's compiler then places each
  // where the target has it.
  for (const obj of [...objs.values()].sort((a, b) => a.order - b.order)) {
    const say = (why: string) => ({ symbol: obj.symbol, refused: why });
    const accesses = access.get(obj.symbol) ?? [];
    const dir = obj.directives;
    // the alignment the target shows
    const shown = dir?.align ?? obj.placement?.align;
    let width: number;
    if (dir?.unit !== undefined) {
      width = dir.unit;
    } else {
      const widths = [...new Set(accesses.map((x) => x.width))];
      if (widths.length > 1) {
        return say(`whose accesses disagree on its element width (${widths.sort().join(' and ')} bytes)`);
      }
      // with no access either, an object aligned below the compiler's aggregate floor is a scalar
      const scalarOnly = shown !== undefined && shown < layout.aggregateAlign;
      width = widths[0] ?? (scalarOnly && [1, 2, 4].includes(obj.size) ? obj.size : 1);
    }
    if (![1, 2, 4].includes(width)) {
      return say(`whose ${width}-byte elements are no integer type`);
    }
    if (obj.size % width !== 0) {
      return say(`whose ${width}-byte elements do not divide its ${obj.size} bytes`);
    }
    // an access of another width reads through a cast, and says nothing about these elements
    const signs = new Set(accesses.filter((x) => x.width === width && x.signed !== undefined).map((x) => x.signed));
    if (signs.size > 1) {
      return say('whose loads disagree on whether its elements are signed');
    }
    const signed = signs.size > 0 ? signs.has(true) : dir?.negative === true;
    const count = obj.size / width;
    const elem = T.int(width * 8, signed);
    const init = zeroed.has(obj.symbol) ? [0] : obj.bytes === undefined ? undefined : elements(obj, width, signed);
    if (zeroed.has(obj.symbol) && count !== 1) {
      return say(
        `laid out ahead of a static declared after it, as only a scalar initialized to zero is, but of ${count} elements`,
      );
    }
    // One element is a scalar — unless it is initialized data holding zero on a compiler that
    // moves a zero scalar to bss, where it can only have been an aggregate, which the compiler
    // keeps in .data.
    const scalar =
      count === 1 && !(layout.zeroScalar === 'bss' && obj.section === 'data' && init!.every((v) => v === 0));
    const type: IrType = scalar ? elem : T.array(elem, count);
    const string = dir?.string === true && width === 1 && !scalar && shown !== undefined && shown >= layout.stringAlign;
    // The alignment the target shows against the one this definition gets from its compiler.
    const own = scalar ? width : Math.max(width, layout.aggregateAlign, string ? layout.stringAlign : 1);
    if (shown !== undefined && shown < own) {
      return say(`whose definition is aligned to ${shown} bytes, less than the ${own} its declaration here would get`);
    }
    const align = shown !== undefined && shown > own ? shown : undefined;
    const isConst = obj.section === 'rodata';
    infos.set(obj.symbol, {
      name: obj.symbol,
      kind: 'data',
      size: obj.size,
      ...(scalar
        ? { shape: 'scalar' as const, signed }
        : { shape: 'array' as const, elemSize: width, elemSigned: signed, dims: [count] }),
      ...(isConst ? { const: true } : {}),
    });
    statics.push({
      name: obj.name,
      type,
      ...(isConst ? { const: true as const } : {}),
      ...(align !== undefined ? { align } : {}),
      ...(init ? { init } : {}),
      ...(string ? { string: true as const } : {}),
    });
  }
  return { infos, statics };
}

/** `sfn` with each static's linker name replaced by its source name — every reference, assignment
 *  targets and the typed-global list included — or the refusal. The tree is final here, so what the
 *  source name would collide with is all in it: every name its body mentions, callees included,
 *  plus its parameters, locals and own name. */
export function nameLocalStatics(sfn: SFn, objs: LocalObjects): SFn | { symbol: string; refused: string } {
  const taken = takenNames(sfn);
  for (const g of sfn.globals ?? []) {
    taken.add(g.name);
  }
  const bound = new Set([...sfn.params, ...sfn.locals].map((x) => x.name));
  const callees = new Set<string>([sfn.name]);
  for (const e of walkExprs(sfn.body)) {
    if (e.k === 'call') {
      callees.add(e.fn);
    }
  }
  const rename = new Map<string, string>();
  const bySource = new Map<string, string>();
  for (const obj of objs.values()) {
    const say = (why: string) => ({ symbol: obj.symbol, refused: `whose source name '${obj.name}' ${why}` });
    const other = bySource.get(obj.name);
    if (other !== undefined) {
      return say(`another static here ('${other}') also has — one block cannot declare both`);
    }
    if (callees.has(obj.name) || taken.has(obj.name)) {
      const what = callees.has(obj.name) ? 'a function' : bound.has(obj.name) ? 'a parameter or local' : 'a global';
      return say(`is also ${what} this one names — the static would hide it`);
    }
    bySource.set(obj.name, obj.symbol);
    rename.set(obj.symbol, obj.name);
  }
  const expr = (e: Expr): Expr => {
    const r = mapExprChildren(e, expr);
    return (r.k === 'var' || r.k === 'addr' || r.k === 'postincr') && rename.has(r.name)
      ? { ...r, name: rename.get(r.name)! }
      : r;
  };
  const assigns = (s: Stmt): Stmt => {
    const r = mapStmtLists(s, (list) => list.map(assigns));
    if (r.k === 'for') {
      return { ...r, init: assigns(r.init), inc: assigns(r.inc) };
    }
    return r.k === 'assign' && rename.has(r.name) ? { ...r, name: rename.get(r.name)! } : r;
  };
  return {
    ...sfn,
    body: sfn.body.map((s) => assigns(mapStmtExprs(s, expr))),
    ...(sfn.globals
      ? {
          globals: sfn.globals
            .map((g) => ({ ...g, name: rename.get(g.name) ?? g.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : {}),
  };
}
