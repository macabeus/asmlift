// Array-of-struct recovery: the scaledAddress extension for NON-scalar strides. Recognizes the
// element-pointer idiom `%elem = add(base, index * stride)` where the stride is read
// AUTHORITATIVELY from the `mul #C` / `shl #k` constant in the machine code (the inversion of
// m2c/Ghidra, which read stride from a supplied type). The element becomes a STRUCT whose fields
// are the residual offsets of the loads/stores off %elem, so `load %elem {off=K}` becomes
// `base[index].field_K`. Rewrites those into `aload`/`astore` carrying `fieldOff`. Byte-exact:
// the element struct is given `size == stride` so its `sizeof` reproduces the observed
// `mul #stride`.
//
// SCALAR-VS-STRUCT DISCRIMINATION (the question that kept this a prototype): a stride==width
// single-field-at-0 access is a plain scalar array and must stay recognizeArrays' shape, not a
// 1-field struct. Resolved by ORDER + the clean gate: this pass runs AFTER `arrays` in
// PRE_RECOVERY_PASSES, so every shl-scaled stride==width off-0 access is already an aload (its
// add is dead) before this pass looks; overlapping residues (off + width > stride) fail the
// clean gate. The one shape that still lands here — a mul-by-power-of-2 the compiler chose over
// shl, which real compilers do not emit — would recover as a 1-field struct: byte-identical
// address math, merely less idiomatic. The mul/shl stride constant is what makes base/index
// UNAMBIGUOUS here (the scaled operand is the index, read from the machine code) — the unscaled
// `add(x, y)` byte form stays out of scope (genuinely ambiguous without types).
import { Fn, Op, Value, defOpMap, mkOp } from '../ir/core';
import { IrType, StructField, T, scalarTypeForAccess } from '../ir/types';

interface Scaled {
  base: Value;
  index: Value;
  stride: number;
}

// `%elem = add(base, index*stride)` — the scaled side is `mul(index, const)` or `shl(index, k)`.
// The `add` is commutative. Returns the base/index/stride, stride read from the constant.
function elementPointer(add: Op, defs: Map<Value, Op>): Scaled | null {
  if (add.opcode !== 'add' || add.operands.length !== 2) {
    return null;
  }
  for (const [s, o] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const d = defs.get(add.operands[s]);
    if (!d) {
      continue;
    }
    if (d.opcode === 'mul' && d.operands.length === 2) {
      const c0 = defs.get(d.operands[0]);
      const c1 = defs.get(d.operands[1]);
      if (c1?.opcode === 'const') {
        return { base: add.operands[o], index: d.operands[0], stride: c1.attrs.value as number };
      }
      if (c0?.opcode === 'const') {
        return { base: add.operands[o], index: d.operands[1], stride: c0.attrs.value as number };
      }
    }
    if (d.opcode === 'shl' && d.operands.length === 1) {
      return { base: add.operands[o], index: d.operands[0], stride: 1 << (d.attrs.imm as number) };
    }
  }
  return null;
}

// Byte width of a recovered field type (pointer word-sized; array = elem × count).
const byteSize = (t: IrType): number =>
  t.kind === 'array' ? byteSize(t.elem) * t.count : t.kind === 'int' ? t.width / 8 : 4;

// Interleave `u8[N]` PAD fields into a sorted data-field list so every data field lands at its exact
// offset and the element's total size == stride. Makes the struct type SELF-DESCRIBING (no size-time
// synthesis in the backend). `char`-style raw bytes are `u8` in the decomp type vocabulary.
function withPadding(dataFields: StructField[], stride: number): StructField[] {
  const out: StructField[] = [];
  let cursor = 0,
    pad = 0;
  for (const f of dataFields) {
    if (f.off > cursor) {
      out.push({ off: cursor, type: T.array(T.u(8), f.off - cursor), name: `_pad${pad++}` });
    }
    out.push(f);
    cursor = f.off + byteSize(f.type);
  }
  if (stride > cursor) {
    out.push({ off: cursor, type: T.array(T.u(8), stride - cursor), name: `_pad${pad}` });
  }
  return out;
}

/** Recover array-of-struct element access. Returns the number of element-pointers recovered.
 *
 *  Element pointers are recovered PER (base, stride) GROUP, not per add: a compiler freely
 *  rematerializes the same element address (several `add(base, i*stride)` ops for one logical
 *  array), and recovering them one-by-one would let the first claim the base and force its
 *  twins to decline — a mixed spelling that is worse than either pure form (found live on
 *  pokeemerald:GetGender, whose address is materialized twice). A base whose element pointers
 *  disagree on stride declines entirely: two strides over one base is a reinterpreted view or
 *  a 2D layout, genuinely ambiguous — decline over guess. */
export function recognizeStructArrays(fn: Fn): number {
  const defs = defOpMap(fn);
  let count = 0;

  // group candidate element pointers by base, tracking each add's own index and stride
  const byBase = new Map<Value, { add: Op; index: Value; stride: number }[]>();
  for (const b of fn.blocks) {
    for (const add of b.ops) {
      const sc = elementPointer(add, defs);
      if (sc && sc.stride > 0) {
        const list = byBase.get(sc.base) ?? [];
        list.push({ add, index: sc.index, stride: sc.stride });
        byBase.set(sc.base, list);
      }
    }
  }

  for (const [base, elems] of byBase) {
    // The base must be RETYPABLE: still `unknown` (this pass runs before recovery seeds it, and
    // an already-recovered type must not be clobbered), agreed on ONE stride, and never itself a
    // DIRECT memory base (`arr->x` alongside `arr[i].y`: the retype would make memAccess resolve
    // the direct access against element fields it may not have).
    if (base.type.kind !== 'unknown') {
      continue;
    }
    const stride = elems[0].stride;
    if (elems.some((e) => e.stride !== stride)) {
      continue;
    }
    let clean = true;
    for (const bb of fn.blocks) {
      for (const op of bb.ops) {
        if ((op.opcode === 'load' || op.opcode === 'store') && op.operands[0] === base) {
          clean = false;
        }
      }
    }

    // Every use of every %elem — across ALL operand positions AND successor block-args (the
    // IR's full use-set, adversarially learned: `store elem, elem {off}` hides elem at
    // operand[1] of its own clean access; a branch can carry elem as a block arg the
    // op-operand scan never sees, leaving a live sizeof-scaling add behind) — must be a
    // load/store BASE with a field offset inside one element.
    const elemSet = new Set(elems.map((e) => e.add.results[0]));
    const indexOf = new Map(elems.map((e) => [e.add.results[0], e.index]));
    const accesses: { op: Op; elem: Value; off: number; width: number; signed: boolean }[] = [];
    for (const bb of fn.blocks) {
      for (const op of bb.ops) {
        const isMem = (op.opcode === 'load' || op.opcode === 'store') && elemSet.has(op.operands[0]);
        if (op.operands.some((o, k) => elemSet.has(o) && (k > 0 || !isMem))) {
          clean = false; // a non-base use — even inside an otherwise-clean access
        }
        if (op.successors.some((sx) => sx.args.some((a) => elemSet.has(a)))) {
          clean = false; // carried into a block arg — a use the rewrite cannot see
        }
        if (isMem) {
          const off = op.attrs.off as number,
            width = op.attrs.width as number;
          if (off < 0 || off + width > stride) {
            clean = false;
          }
          accesses.push({
            op,
            elem: op.operands[0],
            off,
            width,
            signed: op.opcode === 'load' ? (op.attrs.signed as boolean) : width === 4,
          });
        }
      }
    }
    if (!clean || accesses.length === 0) {
      continue;
    }

    // Build the element struct over the UNION of the group's accesses: one field per distinct
    // offset, SIZE = stride (so sizeof matches). The offset set must describe a real C struct —
    // the guards mirror structs.ts:
    //   • same-offset accesses must agree on width (a conflict is a union view, not a field —
    //     collapsing widths deleted a store's byte-range in the adversarial round);
    //   • fields must not OVERLAP (withPadding assumes disjoint; an overlap silently shifts
    //     every later field's physical offset);
    //   • each field must be naturally aligned (off % width) and the stride divisible by the
    //     widest field's alignment — otherwise the DECLARED layout (which C aligns) diverges
    //     from the intended offsets and sizeof ≠ stride.
    // Same-offset rules: widths must agree (any two accesses); LOAD signedness must agree —
    // two loads reading one field with different extensions is a union view, and merging them
    // silently drops one side's zero/sign-extension (adversarially learned: `arr[i].f +
    // (u16)arr[i].f` lost its zext and a byte-exact match with it). A STORE's `signed` is the
    // width===4 CONVENTION, not a machine fact, so it never conflicts — the field takes its
    // signedness from the loads when any exist.
    const byOff = new Map<number, { width: number; loadSigned: boolean | null }>();
    for (const a of accesses) {
      const isLoad = a.op.opcode === 'load';
      const prev = byOff.get(a.off);
      if (!prev) {
        byOff.set(a.off, { width: a.width, loadSigned: isLoad ? a.signed : null });
      } else if (prev.width !== a.width) {
        clean = false;
      } else if (isLoad) {
        if (prev.loadSigned === null) {
          prev.loadSigned = a.signed;
        } else if (prev.loadSigned !== a.signed) {
          clean = false;
        }
      }
    }
    const offs = [...byOff.entries()].sort(([x], [y]) => x - y);
    let maxAlign = 1;
    for (let i = 0; i < offs.length; i++) {
      const [off, { width }] = offs[i];
      if (off % width !== 0) {
        clean = false;
      }
      if (i + 1 < offs.length && off + width > offs[i + 1][0]) {
        clean = false;
      }
      maxAlign = Math.max(maxAlign, width);
    }
    if (stride % maxAlign !== 0) {
      clean = false;
    }
    if (!clean) {
      continue;
    }
    const dataFields: StructField[] = offs.map(([off, { width, loadSigned }]) => ({
      off,
      // store-only field: the width===4 convention, exactly what the old access carried
      type: scalarTypeForAccess(width, loadSigned ?? width === 4),
      name: `field_${off}`,
    }));
    const elemStruct = T.struct(`Elem${count}`, withPadding(dataFields, stride), stride);
    base.type = T.ptr(elemStruct);

    // Rewrite each field load/store into an aload/astore carrying base, ITS elem's index,
    // elemSize, fieldOff. The aload REUSES the load's result value — minting a replacement and
    // RAUW-ing killed a value that a LATER group's captured base/index still referenced (the
    // groups were collected before any rewrite), crashing chained table indexing
    // (`q = o[i].p; q[j].a`) with a use-of-undefined-value; reuse leaves every captured Value
    // alive, so no group can go stale (adversarially learned).
    for (const bb of fn.blocks) {
      for (let i = 0; i < bb.ops.length; i++) {
        const op = bb.ops[i];
        if (!elemSet.has(op.operands[0])) {
          continue;
        }
        const index = indexOf.get(op.operands[0])!;
        if (op.opcode === 'load') {
          bb.ops[i] = mkOp('aload', {
            operands: [base, index],
            results: [op.results[0]],
            attrs: { elemSize: stride, signed: op.attrs.signed as boolean, fieldOff: op.attrs.off as number },
          });
        } else if (op.opcode === 'store') {
          bb.ops[i] = mkOp('astore', {
            operands: [base, index, op.operands[1]],
            attrs: { elemSize: stride, fieldOff: op.attrs.off as number },
          });
        }
      }
    }
    count++;
  }
  return count;
}
