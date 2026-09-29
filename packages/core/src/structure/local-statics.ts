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
// alignment: agbcc aligns an array to its element, mwcc an array or struct to at least a word and
// a scalar to its width. A target aligned wider — a struct, a string, an `s64`, an
// `ALIGNED(32)` — keeps that alignment in an attribute, because a table one element off is misread
// by the machine and scored as a MATCH.
//
// The definition is a SymbolInfo as well as a declaration, because the structurer spells an access
// through a symbol's declared shape (`tide[i]` for an array, the bare `q` for a scalar): the shape
// it spells against and the object the backend defines are one reading of the same facts. Both are
// keyed by the LINKER name the IR carries (`tide.3`), and the finished tree is renamed to the
// source's (`tide`) in one step, `nameLocalStatics`, which is where a clash between that name and
// anything else the function names can first be seen whole.
//
// REFUSES, naming the static, when nothing in the definition settles the width and the accesses
// disagree on it, when the width does not divide the size, when the loads disagree on the
// signedness, when the definition is aligned narrower than its elements; and, at
// the rename, when two statics share a source name (one block cannot declare both) or when the
// function names anything else by it — a global, a callee, a parameter, a local, itself — which the
// block-scope static would hide.
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
export function localStaticShapes(fn: Fn): LocalStaticShapes | { symbol: string; refused: string } {
  const objs = fn.localObjects;
  const infos = new Map<string, SymbolInfo>();
  const statics: SStatic[] = [];
  if (objs === undefined) {
    return { infos, statics };
  }
  const access = accessesOf(fn, new Set(objs.keys()));
  // Declared in the target's declaration order, which the compiler lays the objects out by (mwcc
  // even reverses it in .sbss): the candidate's compiler then places each where the target has it.
  for (const obj of [...objs.values()].sort((a, b) => a.order - b.order)) {
    const say = (why: string) => ({ symbol: obj.symbol, refused: why });
    const accesses = access.get(obj.symbol) ?? [];
    const dir = obj.directives;
    let width: number;
    if (dir?.unit !== undefined) {
      width = dir.unit;
    } else {
      const widths = [...new Set(accesses.map((x) => x.width))];
      if (widths.length > 1) {
        return say(`whose accesses disagree on its element width (${widths.sort().join(' and ')} bytes)`);
      }
      // with no access either, an object mwcc aligned below its aggregate floor is a scalar
      const scalarOnly = obj.placement !== undefined && obj.placement.align < obj.placement.aggregateFloor;
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
    const init = obj.bytes === undefined ? undefined : elements(obj, width, signed);
    // One element is a scalar — unless it is initialized data holding zero, which mwcc moves to
    // .bss as a scalar and keeps in .data as an aggregate (`static int q = 0;` against
    // `static int q[1] = {0};`, compiled), so the array keeps the section the target shows.
    const scalar = count === 1 && !(obj.section === 'data' && init!.every((v) => v === 0));
    const type: IrType = scalar ? elem : T.array(elem, count);
    // The alignment the target shows against the one this definition gets from its compiler.
    const shown = dir?.align ?? obj.placement?.align;
    const own = obj.placement === undefined || scalar ? width : Math.max(width, obj.placement.aggregateFloor);
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
