// asmlift — the C DEFINITION of each function-scope static a function names (ir/core.ts
// `LocalObjects`), typed from the target's own definition and the accesses the function makes.
//
// The frontend hands over what the target shows: section, size and bytes, and where the target is
// an assembler listing (agbcc's `.s`) the definition's directives too. Those say the element: the
// compiler writes each scalar of the initializer with the directive of its width, so a table of
// `.short`s is one of 16-bit elements whatever the function reads out of it, and a narrow negative
// value is only ever written for a signed type. An object file (mwcc) shows no directives, and
// there the element is the one width every access agrees on. The accesses of the element's width
// then settle its signedness, and an object nothing says anything about is bytes.
//
// The listing also shows the ALIGNMENT, which decides where the object lands after the statics
// declared before it. An element type aligns its array to its own width; a definition aligned
// wider — a struct, a string, an `ALIGNED(4)` — keeps that alignment in an attribute, because a
// word table one byte off is misread by the machine and scored as a MATCH. mwcc aligns every
// object in a data section to at least a word (compiled: `u8[9]` then `s16[5]` land at 0 and 12),
// so no element type this pass picks moves one there.
//
// The definition is a SymbolInfo as well as a declaration, because the structurer spells an access
// through a symbol's declared shape (`tide[i]` for an array, the bare `q` for a scalar): the shape
// it spells against and the object the backend defines are one reading of the same facts.
//
// REFUSES, naming the static, when nothing in the definition settles the width and the accesses
// disagree on it, when the width does not divide the size, when the loads and the definition
// disagree on the signedness, when the definition is aligned narrower than its elements, or when a
// callee carries the static's name (the block-scope static would hide the function in the call).
import { type Fn, type LocalObject, type Op, type Value, defOpMap } from '../ir/core';
import { type IrType, T } from '../ir/types';
import type { SStatic } from '../l3/ast';
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
  const callees = new Set(
    fn.blocks.flatMap((b) => b.ops.filter((op) => op.opcode === 'call').map((op) => op.attrs.target as string)),
  );
  const access = accessesOf(fn, new Set(objs.keys()));
  // Declared in the target's declaration order, which the compiler lays the objects out by (mwcc
  // even reverses it in .sbss): the candidate's compiler then places each where the target has it.
  for (const obj of [...objs.values()].sort((a, b) => a.order - b.order)) {
    const say = (why: string) => ({ symbol: obj.symbol, refused: why });
    if (callees.has(obj.name) || obj.name === fn.name) {
      return say(`whose source name '${obj.name}' is also a function this one names — the static would hide it`);
    }
    const accesses = access.get(obj.name) ?? [];
    const dir = obj.directives;
    let width: number;
    if (dir?.unit !== undefined) {
      width = dir.unit;
    } else {
      const widths = [...new Set(accesses.map((x) => x.width))];
      if (widths.length > 1) {
        return say(`whose accesses disagree on its element width (${widths.sort().join(' and ')} bytes)`);
      }
      width = widths[0] ?? 1;
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
    if (dir?.negative === true && signs.has(false)) {
      return say('whose definition holds negative elements that its loads read zero-extended');
    }
    const signed = dir?.negative === true || signs.has(true);
    if (dir !== undefined && dir.align < width) {
      return say(`whose definition is aligned to ${dir.align} bytes, less than its ${width}-byte elements are`);
    }
    const align = dir !== undefined && dir.align > width ? dir.align : undefined;
    const count = obj.size / width;
    const elem = T.int(width * 8, signed);
    const init = obj.bytes === undefined ? undefined : elements(obj, width, signed);
    // One element is a scalar — unless it is initialized data holding zero, which mwcc moves to
    // .bss as a scalar and keeps in .data as an aggregate (`static int q = 0;` against
    // `static int q[1] = {0};`, compiled), so the array keeps the section the target shows.
    const scalar = count === 1 && !(obj.section === 'data' && init!.every((v) => v === 0));
    const type: IrType = scalar ? elem : T.array(elem, count);
    const isConst = obj.section === 'rodata';
    infos.set(obj.name, {
      name: obj.name,
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
