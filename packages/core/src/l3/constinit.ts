// asmlift — a local aggregate's constant INITIALIZER, recovered from the copy that fills it.
//
// `u8 a[16] = { 0, 1, 2, … };` is not a statement in the machine. A compiler that keeps the
// aggregate in memory places the initial image as a constant of its own, under a label the source
// never wrote, and copies it into the frame at entry: agbcc 2.9 writes `.LC0:` in .rodata and
// `ldr r1,=.LC0; mov r0,sp; mov r2,#16; bl memcpy` (varasm.c `output_constant_def`, expr.c
// `store_constructor` → `emit_block_move`). The lift reads that image as an ANONYMOUS object
// (ir/core.ts `LocalObject.anonymous`), so the tree holds the copy as written —
// `memcpy(sp0, .LC0, 16)` — and the image in `SFn.images`, which no declaration spells. This pass
// spells the pair back as the declaration it came from: the local's initializer, and no copy.
//
// IT RUNS AT EMISSION, NOT IN STRUCTURE. Between the two the tree belongs to the contracts and the
// respell variations, and every one of them is right about the copy as it stands: it is a call the
// asm makes (contracts.ts `assertEffectsPreserved` counts it), and it takes the local's address,
// which is what keeps dead-store elimination and the coalescers off the object. A folded tree
// would hold a local nothing mentions, which l3/dce.ts deletes — and with it the initializer the
// compiler keeps (agbcc copies `u8 a[16] = {…}` even when nothing reads `a`). So structure()
// asks this pass whether the fold is possible and refuses the function loudly where it is not,
// and the C-family emitter folds (backend/cfamily.ts), the same seam l3/slotorder.ts uses.
//
// THE FOLD IS SOUND exactly when the declaration's initializer and the copy are one program:
//   • the copy is a block copy this table knows (`BLOCK_COPIES`), a TOP-LEVEL statement of the
//     body, so it runs once and on every path that reaches it;
//   • its destination is a whole local integer array of the copied size — or a reservation the
//     frame rounded up by less than a word, reached by nothing but elements inside the copy and its
//     whole address — not volatile, and nothing before the copy mentions it but a local assigned
//     its address alone, so moving the copy to the declaration changes no value anything reads (an
//     initializer runs at entry, the copy at its own position);
//   • its source is the whole image, which nothing but such copies mentions, and whose size is the
//     count — one image may fill several locals, since the compiler places one per identical
//     constant (varasm.c `output_constant_def`), each into its own local. KNOWN GAP: Thumb's
//     frame audit reserves a frame's address-taken bytes as one local, so two arrays refuse at the
//     size check, whether or not they share an image;
//   • the image writes one element width (a struct's mixed widths, or padding alone, has no
//     element type this pass could declare).
// The local keeps its own element type where the body reaches it by an offset or a cast — those
// were spelled against it, so its width must be the image's — and takes the image's where only
// its whole address and element accesses, which each print their own width, reach it.
//
// Thumb is the only frontend that reads an anonymous image today. The rule is asked of the tree,
// for any compiler, but the only copy it reads is a call (`BLOCK_COPIES`). KNOWN GAP: an INLINE
// copy — agbcc's `ldmia`/`stmia` for a word-aligned image below its memcpy sizes, lw/sw or
// lwl/lwr+swl/swr (IDO, gcc 2.7.2, KMC), lwz/stw (mwcc) — declines, naming the copy it does not
// read; no benchmark row has one, and the MIPS and PPC frontends refuse the address-taken frame
// local before the copy is reached.
import { type IrType, typeToString } from '../ir/types';
import { type Expr, type SFn, type SImage, type Stmt, mentionedName, walkExprs } from './ast';
import { localMentions, mentionsAnyLocal } from './mentions';

/** The block copies a compiler emits for an aggregate initializer, by callee: which argument is
 *  the destination, the source and the byte count. */
export const BLOCK_COPIES: Readonly<Record<string, { dst: number; src: number; n: number }>> = {
  memcpy: { dst: 0, src: 1, n: 2 },
};

/** `e` without the casts around it. */
function bare(e: Expr): Expr {
  return e.k === 'cast' ? bare(e.e) : e;
}

/** The value of `e` where it is integer arithmetic on constants alone, or null. A copy's count is
 *  a constant the machine may build in several instructions — agbcc spells 256 and up as an 8-bit
 *  immediate shifted (`mov r2,#0x80; lsl r2,r2,#1`), which the tree keeps as `128 << 1`. */
function constantValue(e: Expr): number | null {
  const b = bare(e);
  if (b.k === 'const') {
    return b.value;
  }
  if (b.k !== 'bin') {
    return null;
  }
  const l = constantValue(b.l);
  const r = constantValue(b.r);
  if (l === null || r === null) {
    return null;
  }
  switch (b.op) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '<<':
      return r >= 0 && r < 32 ? l * 2 ** r : null;
    case '|':
      return l >= 0 && r >= 0 && l < 2 ** 31 && r < 2 ** 31 ? l | r : null;
    default:
      return null;
  }
}

/** The object `e` names whole — `x` or `&x` — or null. */
function wholeObject(e: Expr): string | null {
  const b = bare(e);
  return b.k === 'postincr' ? null : (mentionedName(b) ?? null);
}

/** Every mention of `name` as an expression in `body`. */
function mentions(body: readonly Stmt[], name: string): number {
  let n = 0;
  for (const e of walkExprs(body as Stmt[])) {
    if (mentionedName(e) === name) {
      n++;
    }
  }
  return n;
}

const byteSize = (t: IrType): number | null =>
  t.kind === 'int'
    ? t.width / 8
    : t.kind === 'array'
      ? (() => {
          const e = byteSize(t.elem);
          return e === null ? null : e * t.count;
        })()
      : null;

/** `v`, an element of `width` bytes, read at the given signedness. */
function resign(v: number, width: number, signed: boolean): number {
  const bits = 8 * width;
  const u = ((v % 2 ** bits) + 2 ** bits) % 2 ** bits;
  return signed && u >= 2 ** (bits - 1) ? u - 2 ** bits : u;
}

/** One copy's fold: the copy statement's index, the local and its declaration. */
interface Fold {
  at: number;
  local: string;
  type: IrType;
  init: (number | null)[];
  string: boolean;
}

/** Why `image` cannot fold, as the tail of a sentence naming it, or the fold of each copy of it. */
function planFolds(sfn: SFn, image: SImage): Fold[] | string {
  if (image.type.kind !== 'array' || image.type.elem.kind !== 'int') {
    return 'whose image writes no one element width — a struct, or padding alone';
  }
  const copies: number[] = [];
  sfn.body.forEach((s, i) => {
    if (
      s.k === 'exprstmt' &&
      s.value.k === 'call' &&
      typeof s.value.fn === 'string' &&
      BLOCK_COPIES[s.value.fn] !== undefined &&
      wholeObject(s.value.args[BLOCK_COPIES[s.value.fn].src] ?? { k: 'const', value: 0 }) === image.name
    ) {
      copies.push(i);
    }
  });
  if (copies.length === 0) {
    return (
      'which no top-level block-copy call (memcpy) takes as its source — the one copy folded into an ' +
      'initializer; an inline, element-by-element copy of the image, and any other read of it, is not'
    );
  }
  if (mentions(sfn.body, image.name) !== copies.length) {
    return 'which the body reads other than as the source of a block copy at the top level';
  }
  const folds: Fold[] = [];
  for (const at of copies) {
    const fold = planCopy(sfn, image, at);
    if (typeof fold === 'string') {
      return fold;
    }
    folds.push(fold);
  }
  return folds;
}

/** Why the block copy of `image` at body index `at` cannot fold, or its fold. */
function planCopy(sfn: SFn, image: SImage, at: number): Fold | string {
  const elem = (image.type as Extract<IrType, { kind: 'array' }>).elem as Extract<IrType, { kind: 'int' }>;
  const size = byteSize(image.type)!;
  const call = (sfn.body[at] as Extract<Stmt, { k: 'exprstmt' }>).value as Extract<Expr, { k: 'call' }>;
  const roles = BLOCK_COPIES[call.fn as string];
  if (constantValue(call.args[roles.n] ?? { k: 'var', name: '' }) !== size) {
    return `whose copy does not move its whole ${size} bytes`;
  }
  const local = wholeObject(call.args[roles.dst] ?? { k: 'const', value: 0 });
  const decl = sfn.locals.find((l) => l.name === local);
  if (local === null || decl === undefined) {
    return 'whose copy does not fill a local of this function';
  }
  if (decl.init !== undefined) {
    return `whose copy fills '${local}', which another image already initializes`;
  }
  if (decl.volatile || decl.pointeeVolatile) {
    return `whose copy fills '${local}', which is volatile`;
  }
  const declElem = decl.type.kind === 'array' ? decl.type.elem : null;
  const declSize = byteSize(decl.type);
  // The copy moves the whole object — a brace initializer's image carries its zero tail — so the
  // count is the object's size, and a reservation the frame audit measured wider by less than a
  // word is the frame's own rounding (agbcc rounds a 6-byte array's frame to 8).
  if (declElem === null || declElem.kind !== 'int' || declSize === null || declSize < size || declSize - size >= 4) {
    return `whose copy fills '${local}', a ${typeToString(decl.type)}, which is not an integer array of its ${size} bytes`;
  }
  // A local that holds nothing but the local's address — `p0 = (u8 *)&sp0;`, the base the
  // readability hoist (l3/basecse.ts) places at the head of the body, ahead of the copy — reads no
  // element where it is assigned, so the copy may move past it; its uses are the local's.
  const aliasAt = aliasesOf(sfn, local);
  const reach = new Set([local, ...aliasAt.keys()]);
  const aliasing = new Set(aliasAt.values());
  const kept = sfn.body.filter((_, i) => i !== at && !aliasing.has(i));
  if (
    mentionsAnyLocal(
      sfn.body.slice(0, at).filter((_, i) => !aliasing.has(i)),
      reach,
    )
  ) {
    return `whose copy into '${local}' is not the first thing the body does with it`;
  }
  const use = uses(kept, reach);
  const count = size / (elem.width / 8);
  // Reached as anything but elements, the local may be reached past the bytes copied — the tail a
  // fill writes after a short string's copy — so the reservation must be the copy's exactly.
  if (use.other && byteSize(decl.type) !== size) {
    return `whose copy fills '${local}', a ${typeToString(decl.type)} the body reaches past the ${size} bytes copied`;
  }
  if (use.extents.some(([from, to]) => from < 0 || to > size)) {
    return `whose copy fills '${local}', which the body indexes past the ${size} bytes copied`;
  }
  // An offset or a cast was spelled against the local's own element, so the image's must match and
  // the local keeps its type. Element accesses print their own width, so where only they and the
  // whole address reach it, the declaration (the frame audit may type it by bytes alone) witnesses
  // nothing: the image says the element, and its signedness where it writes a negative (agbcc does
  // only for a signed element), else the reads of that width do.
  let own: Extract<IrType, { kind: 'int' }>;
  if (use.other) {
    if (declElem.width !== elem.width) {
      return `whose ${elem.width / 8}-byte elements are not the ${declElem.width / 8}-byte elements the body reaches '${local}' by`;
    }
    own = declElem;
  } else {
    const signs = new Set(use.reads.filter((r) => r.width * 8 === elem.width).map((r) => r.signed));
    const signed =
      elem.signed ||
      (signs.size === 1 ? [...signs][0] : declElem.width === elem.width && use.indexed > 0 && declElem.signed);
    own = { ...elem, signed };
  }
  return {
    at,
    local,
    type: { kind: 'array', elem: own, count },
    init: image.init.map((v) => (v === null ? null : resign(v, elem.width / 8, own.signed))),
    string: image.string === true && elem.width === 8,
  };
}

/** The locals of `sfn` that hold `local`'s address and nothing else — assigned it once, at the top
 *  level of the body, and never written through `&` — each with the index of that assignment. */
function aliasesOf(sfn: SFn, local: string): Map<string, number> {
  const counts = localMentions(sfn);
  const out = new Map<string, number>();
  sfn.body.forEach((s, i) => {
    const m = s.k === 'assign' ? counts.get(s.name) : undefined;
    if (
      s.k === 'assign' &&
      s.name !== local &&
      m?.assigns === 1 &&
      m.addrTaken === 0 &&
      wholeObject(s.value) === local
    ) {
      out.set(s.name, i);
    }
  });
  return out;
}

/** How `body` reaches the object the names in `reach` all denote whole: the byte extent of each
 *  direct element access with a constant index (`sp0[k]`, `((u8 *)sp0)[k]`, `p0[k]` — the index
 *  node carries its own width), how many of those there are in all, and whether anything reaches
 *  it other than as a whole call argument or a direct element access. */
function uses(
  body: readonly Stmt[],
  reach: ReadonlySet<string>,
): { indexed: number; extents: [number, number][]; reads: { width: number; signed: boolean }[]; other: boolean } {
  let total = 0;
  let accounted = 0;
  let indexed = 0;
  const extents: [number, number][] = [];
  const reads: { width: number; signed: boolean }[] = [];
  const reaches = (e: Expr): boolean => {
    const n = wholeObject(e);
    return n !== null && reach.has(n);
  };
  for (const e of walkExprs(body as Stmt[])) {
    const n = mentionedName(e);
    if (n !== undefined && reach.has(n)) {
      total++;
    }
    if (e.k === 'call') {
      accounted += e.args.filter(reaches).length;
    }
    if (e.k === 'index' && reaches(e.base)) {
      accounted++;
      indexed++;
      reads.push({ width: e.width, signed: e.signed });
      const k = bare(e.idx);
      if (k.k === 'const') {
        extents.push([k.value * e.width, (k.value + 1) * e.width]);
      }
    }
  }
  return { indexed, extents, reads, other: total !== accounted };
}

/** Whether every anonymous image `sfn` holds folds into a local's initializer: null when it does,
 *  else the image's name and the tail of the sentence that refuses it. */
export function constantImageRefusal(sfn: SFn): { image: string; refused: string } | null {
  for (const image of sfn.images ?? []) {
    const plan = planFolds(sfn, image);
    if (typeof plan === 'string') {
      return { image: image.name, refused: plan };
    }
  }
  return null;
}

/** `sfn` with every anonymous image folded into the initializer of each local its copies fill,
 *  the copies gone and the image with them. Throws where one does not fold: structure() refused
 *  that function already, so a tree that reaches here unfoldable was made so by a later pass. */
export function foldConstantImages(sfn: SFn): SFn {
  if (sfn.images === undefined) {
    return sfn;
  }
  let out: SFn = { ...sfn };
  delete out.images;
  for (const image of sfn.images) {
    const plan = planFolds(out, image);
    if (typeof plan === 'string') {
      throw new Error(`cannot spell '${sfn.name}': the compiler's anonymous constant '${image.name}' ${plan}`);
    }
    const copies = new Set(plan.map((f) => f.at));
    const by = new Map(plan.map((f) => [f.local, f]));
    out = {
      ...out,
      body: out.body.filter((_, i) => !copies.has(i)),
      locals: out.locals.map((l) => {
        const f = by.get(l.name);
        return f === undefined
          ? l
          : { ...l, type: f.type, init: f.init, ...(f.string ? { initString: true as const } : {}) };
      }),
    };
  }
  return out;
}
