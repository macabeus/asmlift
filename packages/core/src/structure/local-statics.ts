// asmlift — the C DEFINITION of each function-scope static a function names (ir/core.ts
// `LocalObjects`), typed from the accesses the function makes.
//
// The frontend hands over what the target shows: section, size and bytes. What it cannot hand
// over is the element TYPE, which the object file does not record and the accesses do: a `ldrb`
// through the address reads a byte, a `lwz` a word. So the element width is the one width every
// access agrees on, and the element signedness the one extension every narrow load agrees on. An
// object the function only passes around has no access to ask, and is defined as bytes.
//
// The definition is a SymbolInfo as well as a declaration, because the structurer spells an access
// through a symbol's declared shape (`tide[i]` for an array, the bare `q` for a scalar): the shape
// it spells against and the object the backend defines are one reading of the same facts.
//
// REFUSES, naming the static, when the accesses disagree on the width or on the extension, when
// the width does not divide the size, or when a callee carries the static's name (the block-scope
// static would hide the function in the call).
import { type Fn, type LocalObject, type Value, defOpMap } from '../ir/core';
import { type IrType, T } from '../ir/types';
import type { SStatic } from '../l3/ast';
import { type SymbolInfo, accessSignedness } from '../symbols';

/** Each static's shape for the structurer, and its definition for the backend. */
export interface LocalStaticShapes {
  infos: Map<string, SymbolInfo>;
  statics: SStatic[];
}

/** The element each access through `obj`'s address reads or writes: width and load extension. */
function accessesOf(fn: Fn, names: ReadonlySet<string>): Map<string, { widths: Set<number>; signs: Set<boolean> }> {
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
  const out = new Map<string, { widths: Set<number>; signs: Set<boolean> }>();
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
      const a = out.get(sym) ?? out.set(sym, { widths: new Set(), signs: new Set() }).get(sym)!;
      const width = (plain ? op.attrs.width : op.attrs.elemSize) as number;
      a.widths.add(width);
      if (op.opcode === 'load' || op.opcode === 'aload') {
        a.signs.add(accessSignedness(width, op.attrs.signed as boolean | undefined));
      }
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
    const a = access.get(obj.name);
    const widths = [...(a?.widths ?? [])];
    if (widths.length > 1) {
      return say(`whose accesses disagree on its element width (${widths.sort().join(' and ')} bytes)`);
    }
    const width = widths[0] ?? 1;
    if (![1, 2, 4].includes(width) || obj.size % width !== 0) {
      return say(`whose ${width}-byte accesses do not divide its ${obj.size} bytes into elements`);
    }
    if ((a?.signs.size ?? 0) > 1) {
      return say('whose loads disagree on whether its elements are signed');
    }
    const signed = a?.signs.has(true) ?? false;
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
    statics.push({ name: obj.name, type, ...(isConst ? { const: true as const } : {}), ...(init ? { init } : {}) });
  }
  return { infos, statics };
}
