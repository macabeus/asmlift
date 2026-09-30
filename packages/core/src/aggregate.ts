// asmlift — a declared struct or union on a target: its size, and whether a function returning it
// by value hands it back through a hidden pointer. The members come from a declaration
// (`proto.ts` AggregateLayout); the layout rules and the return rule are the target's
// (`compilerBehaviors.aggregateBoundary`, `largestAlignment`, `aggregateReturn`).
import { type IrType, type StructField, T } from './ir/types';
import {
  type AggregateLayout,
  type AggregateMember,
  type FnProto,
  type Prototypes,
  STANDARD_SIGNATURES,
  declaredWidth,
  declaresAggregateReturn,
  declaresVoidReturn,
} from './proto';
import type { TargetDescription } from './target';

/** The size and alignment of a laid-out aggregate in bytes, or undefined where the declaration or
 *  the target leaves either open: a member not laid out, a member whose size or placement the
 *  target does not state (an enum, a bitfield), or a target that states no largest alignment. */
export function aggregateSize(
  layout: AggregateLayout,
  target: TargetDescription,
): { size: number; align: number } | undefined {
  const placed = place(layout, target);
  return placed && { size: placed.size, align: placed.align };
}

/** Each member's offset — a bitfield's is the byte its first bit is in — with the aggregate's size
 *  and alignment: `aggregateSize`'s walk. The cursor is in bits, since a bitfield can end
 *  mid-byte. */
function place(
  layout: AggregateLayout,
  target: TargetDescription,
): { size: number; align: number; offsets: number[] } | undefined {
  const { aggregateBoundary, largestAlignment, bitfieldPacking } = target.compilerBehaviors;
  if (layout.members === undefined || aggregateBoundary === undefined || largestAlignment === undefined) {
    return undefined;
  }
  let bits = 0;
  let align = aggregateBoundary;
  const offsets: number[] = [];
  for (const m of layout.members) {
    if (m.bits !== undefined) {
      if (bitfieldPacking !== 'contiguous' || m.bits === 0 || typeof m.type !== 'string') {
        return undefined;
      }
      if (scalarBytes(m.type, target) === undefined) {
        return undefined;
      }
      offsets.push(layout.kind === 'struct' ? Math.floor(bits / 8) : 0);
      bits = layout.kind === 'struct' ? bits + m.bits : Math.max(bits, m.bits);
      continue;
    }
    const one = memberSize(m, target);
    if (one === undefined) {
      return undefined;
    }
    align = Math.max(align, one.align);
    if (layout.kind === 'struct') {
      offsets.push(roundUp(Math.ceil(bits / 8), one.align));
      bits = (offsets[offsets.length - 1] + one.size) * 8;
    } else {
      offsets.push(0);
      bits = Math.max(bits, one.size * 8);
    }
  }
  return { size: roundUp(Math.ceil(bits / 8), align), align, offsets };
}

/** A declared struct as the IR types it: `name` at the size this target lays it out at, spelled as
 *  the headers spell it (`spelling`, which is what marks it theirs — ir/types.ts), with a field at
 *  its offset for each member the IR can type: a scalar, a pointer, or an array of either. A member
 *  it cannot — a nested struct or union, a bitfield, an enum, a plain `char`, whose signedness is
 *  the compiler's and stated nowhere — has no field, and so no read of it is typed. The struct is
 *  DEFINED from the declaration (declare.ts), not from these fields. Undefined for a union, whose IR
 *  type carries no name to declare it by, and where this target does not size it. */
export function aggregateType(
  name: string,
  spelling: string,
  layout: AggregateLayout,
  target: TargetDescription,
): IrType | undefined {
  const placed = layout.kind === 'struct' ? place(layout, target) : undefined;
  if (placed === undefined) {
    return undefined;
  }
  const fields: StructField[] = [];
  for (const [i, m] of layout.members!.entries()) {
    const scalar = m.bits === undefined && typeof m.type === 'string' ? scalarType(m.type) : undefined;
    if (scalar !== undefined) {
      const type = (m.dims ?? []).reduceRight<IrType>((elem, n) => T.array(elem, n), scalar);
      fields.push({ off: placed.offsets[i], type, name: m.name });
    }
  }
  return { kind: 'struct', name, fields, size: placed.size, declared: spelling };
}

/** The IR type of a scalar or pointer member spelling: a pointer to a scalar keeps its pointee, any
 *  other pointer is `void *`, which lays out the same. */
function scalarType(spelling: string): IrType | undefined {
  const s = spelling
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (s.endsWith('*')) {
    return T.ptr(scalarType(s.slice(0, -1)) ?? T.void());
  }
  if (s === 'float' || s === 'double') {
    return s === 'float' ? T.f32() : T.f64();
  }
  const bits = declaredWidth(s);
  return bits === undefined || s === 'char' ? undefined : T.int(bits, !/^u\d|\bunsigned\b/.test(s));
}

function memberSize(m: AggregateMember, target: TargetDescription): { size: number; align: number } | undefined {
  const count = (m.dims ?? []).reduce((n, d) => n * d, 1);
  if (typeof m.type !== 'string') {
    const inner = aggregateSize(m.type, target);
    return inner === undefined ? undefined : { size: inner.size * count, align: inner.align };
  }
  const bytes = scalarBytes(m.type, target);
  if (bytes === undefined) {
    return undefined;
  }
  return { size: bytes * count, align: Math.min(bytes, target.compilerBehaviors.largestAlignment!) };
}

/** The bytes a scalar or pointer member spelled `spelling` takes in storage. Not `declaredWidth`'s
 *  question, which is how many argument registers a parameter takes, and which leaves the floating
 *  types out because on an FPU target they take none: in memory a `float` is 4 bytes and a `double`
 *  8 on every target here (IEEE single and double). An enum (`enum E`) is the target's `enumBytes`,
 *  and unsized where it states none. */
function scalarBytes(spelling: string, target: TargetDescription): number | undefined {
  const s = spelling
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (/^enum [A-Za-z_]\w*$/.test(s)) {
    return target.compilerBehaviors.enumBytes;
  }
  const bits = s === 'float' ? 32 : s === 'double' ? 64 : declaredWidth(s);
  return bits === undefined ? undefined : bits / 8;
}

const roundUp = (n: number, to: number): number => Math.ceil(n / to) * to;

/** The aggregate a declaration says `p` returns by value (`declaresAggregateReturn`): its stated
 *  layout, or the bare kind its `returns` spells. */
export function returnedAggregate(p: FnProto): AggregateLayout {
  return p.returnLayout ?? { kind: /\bunion\b/.test(p.returns ?? '') ? 'union' : 'struct' };
}

/** Whether a function declared to return `layout` by value hands it back through memory — so its
 *  caller passes the address as argument 0 — or `undefined` where the target states no rule or the
 *  rule needs a size the layout does not give. */
export function returnsInMemory(layout: AggregateLayout, target: TargetDescription): boolean | undefined {
  const rule = target.compilerBehaviors.aggregateReturn;
  if (rule === undefined) {
    return undefined;
  }
  if (rule === 'svr4') {
    const size = aggregateSize(layout, target)?.size;
    return size === undefined ? undefined : size > 8;
  }
  // agbcc thumb.c:1423-1493: a struct's second member that is not a bitfield puts it in memory
  // whatever its size; otherwise anything over a word does
  const members = layout.members;
  if (layout.kind === 'struct' && members?.slice(1).some((m) => m.bits === undefined)) {
    return true;
  }
  const size = aggregateSize(layout, target)?.size;
  if (size === undefined) {
    return undefined;
  }
  if (size > 4 || layout.kind === 'struct') {
    return size > 4;
  }
  // a union: in memory as soon as one member would be on its own — an array member is an aggregate
  // that is neither a struct nor a union, which thumb.c puts in memory (line 1491)
  let answer: boolean | undefined = false;
  for (const m of members!) {
    const own = m.dims !== undefined ? true : typeof m.type === 'string' ? false : returnsInMemory(m.type, target);
    if (own === true) {
      return true;
    }
    if (own === undefined) {
      answer = undefined;
    }
  }
  return answer;
}

/** Whether a call to `callee` is KNOWN not to be handed a hidden struct-return pointer in
 *  argument 0. A callee that returns nothing has no such pointer to be given; neither has one
 *  whose return travels in a register. Every other answer — including silence — is `false`,
 *  because this is a fact a caller must be TOLD: the two frames are the same instructions in the
 *  same order, so there is nothing in the assembly to read it off.
 *
 *  A RETURN WIDER THAN A REGISTER STILL TRAVELS IN REGISTERS — it travels in a PAIR, which is
 *  still not a hidden pointer the caller supplied — so `declaredWidth` answering 64 is the right
 *  answer here rather than a width that slipped through a test meant for words. Nothing reaches
 *  it: `STANDARD_SIGNATURES` has one entry and it returns `void *`.
 *
 *  TWO SOURCES AND NEITHER RANKS ABOVE THE OTHER, because on this one question they cannot
 *  disagree: the project's own headers — `returnsVoid`, or a struct or union `target` hands back
 *  in a register — and the `returns` of a signature the C standard fixes, which is as known as its
 *  parameters. That a project may re-declare a standard
 *  function differently is real and is why `declaredCall` ranks the two for ARITY — but a
 *  re-declaration that changed `memcpy` into a struct-returning function would not be `memcpy`.
 *
 *  `Object.hasOwn`, not `in`: `prototypes` is caller-supplied JSON and the table is an object
 *  literal, so `in` would answer for `toString` and every other name on `Object.prototype`. The
 *  ENTRY is read through `?.` for the other half of the same fact: `decompile` is a published
 *  entry point that runs no `validatePrototypes`, so a `null` entry out of parsed JSON reaches
 *  here, and a raw TypeError would leave through neither the decline channel nor anything a
 *  caller can act on. Every other reader of this table — `declaredArgWidths`, and `declaredCall`
 *  through it — answers "nothing is declared" for such an entry, and so does this. */
export function returnsWithoutHiddenPointer(
  callee: string,
  prototypes: Prototypes,
  target: TargetDescription,
): boolean {
  // Nothing at all, a value in registers, or a spelling nobody here can size — the last of which is
  // the only one that leaves the hidden pointer open. A pair is `declaredWidth` 64 and still
  // travels in registers, so a width wider than a word is an answer here and not an overflow.
  const travelsInRegisters = (spelling: string): boolean => {
    const t = spelling.trim();
    return t === 'void' || declaredWidth(t) !== undefined;
  };
  const own = Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined;
  if (declaresVoidReturn(own)) {
    return true;
  }
  // A STRUCT OR UNION IS THE TARGET'S TO PLACE — agbcc hands a one-word struct back in r0, mwcc up
  // to eight bytes in r3/r3:r4 — so this asks the rule the call lowering reads, and the two cannot
  // disagree. A rule or a size nothing states leaves the pointer open.
  if (own && declaresAggregateReturn(own)) {
    return returnsInMemory(returnedAggregate(own), target) === false;
  }
  // A PROJECT'S OWN `returns` ANSWERS THIS THROUGH THE SAME READING A STANDARD SIGNATURE'S DOES,
  // and it ranks above the table for the same reason `declaredCall` ranks a re-declaration above
  // one: a project that spells the return has told you about the function it is building.
  if (own?.returns !== undefined) {
    return travelsInRegisters(own.returns);
  }
  return Object.hasOwn(STANDARD_SIGNATURES, callee) && travelsInRegisters(STANDARD_SIGNATURES[callee].returns);
}
