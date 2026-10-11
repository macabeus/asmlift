// asmlift — a local aggregate's constant INITIALIZER, recovered from the copy that fills it.
//
// `u8 a[16] = { 0, 1, 2, … };` is not a statement in the machine. A compiler that keeps the
// aggregate in memory places the initial image as a constant of its own, under a label the source
// never wrote, and copies it into the frame at entry: agbcc 2.9 writes `.LC0:` in .rodata and
// `ldr r1,=.LC0; mov r0,sp; mov r2,#16; bl memcpy` (varasm.c `output_constant_def`, expr.c
// `store_constructor` → `emit_block_move`). The lift reads that image as an ANONYMOUS object
// (ir/core.ts `LocalObject.anonymous`), so the tree holds the copy as written —
// `memcpy(sp0, .LC0, 16)` — and the image as an `SStatic` no declaration can spell. This pass
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
//     whole address — not volatile, and nothing before the copy mentions it, so moving the copy to
//     the declaration changes no value anything reads (an initializer runs at entry, the copy at
//     its own position);
//   • its source is the whole image, which nothing else mentions, and whose size is the count;
//   • the image writes one element width (a struct's mixed widths, or padding alone, has no
//     element type this pass could declare).
// The local keeps its own element type where the body reads or writes it — the accesses were
// spelled against it, so its width must be the image's — and takes the image's where nothing
// else touches it, which is then the only witness of the source's element type.
//
// Thumb is the only frontend that reads an anonymous image today. The rule is asked of the tree,
// for any compiler: IDO, KMC GCC, gcc 2.7.2 and mwcc copy a local aggregate's initializer from an
// anonymous read-only constant too, and their frontends refuse the address-taken frame local first.
import { type IrType, typeToString } from '../ir/types';
import { type Expr, type SFn, type SStatic, type Stmt, mentionedName, walkExprs } from './ast';
import { mentionsAnyLocal } from './mentions';

/** The block copies a compiler emits for an aggregate initializer, by callee: which argument is
 *  the destination, the source and the byte count. */
export const BLOCK_COPIES: Readonly<Record<string, { dst: number; src: number; n: number }>> = {
  memcpy: { dst: 0, src: 1, n: 2 },
};

/** `e` without the casts around it. */
function bare(e: Expr): Expr {
  return e.k === 'cast' ? bare(e.e) : e;
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

/** One image's fold: the copy statement's index, the local and its declaration. */
interface Fold {
  image: SStatic;
  at: number;
  local: string;
  type: IrType;
  init: number[];
  string: boolean;
}

/** Why `image` cannot fold, as the tail of a sentence naming it, or its fold. */
function planFold(sfn: SFn, image: SStatic): Fold | string {
  if (image.type.kind !== 'array' || image.type.elem.kind !== 'int' || image.init === undefined) {
    return 'whose image writes no one element width — a struct, or padding alone';
  }
  const elem = image.type.elem;
  const size = byteSize(image.type)!;
  if (mentions(sfn.body, image.name) !== 1) {
    return 'which the body reads more than once, or never';
  }
  const at = sfn.body.findIndex(
    (s) =>
      s.k === 'exprstmt' &&
      s.value.k === 'call' &&
      typeof s.value.fn === 'string' &&
      BLOCK_COPIES[s.value.fn] !== undefined &&
      wholeObject(s.value.args[BLOCK_COPIES[s.value.fn].src] ?? { k: 'const', value: 0 }) === image.name,
  );
  if (at === -1) {
    return 'whose one read is not the source of a block copy at the top level of the body';
  }
  const call = (sfn.body[at] as Extract<Stmt, { k: 'exprstmt' }>).value as Extract<Expr, { k: 'call' }>;
  const roles = BLOCK_COPIES[call.fn as string];
  const n = bare(call.args[roles.n] ?? { k: 'var', name: '' });
  if (n.k !== 'const' || n.value !== size) {
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
  if (mentionsAnyLocal(sfn.body.slice(0, at), new Set([local]))) {
    return `whose copy into '${local}' is not the first thing the body does with it`;
  }
  // Where the body reaches the local by anything but its whole address handed to a call — an
  // element, an offset, a cast — that spelling was made against the local's own element, so the
  // image's must be the same width, and the local keeps its type. Where it does not, the image's
  // directives are the only witness of the source's element type, and the local takes it.
  const use = uses(
    sfn.body.filter((_, i) => i !== at),
    local,
  );
  const count = size / (elem.width / 8);
  // Reached as anything but elements, the local may be reached past the bytes copied — the tail a
  // fill writes after a short string's copy — so the reservation must be the copy's exactly.
  if (use.other && byteSize(decl.type) !== size) {
    return `whose copy fills '${local}', a ${typeToString(decl.type)} the body reaches past the ${size} bytes copied`;
  }
  if (use.other || use.indices.length > 0) {
    if (declElem.width !== elem.width) {
      return `whose ${elem.width / 8}-byte elements are not the ${declElem.width / 8}-byte elements the body reaches '${local}' by`;
    }
    if (use.indices.some((k) => k < 0 || k >= count)) {
      return `whose copy fills '${local}', which the body indexes past the ${count} elements copied`;
    }
  }
  const own = use.other || use.indices.length > 0 ? declElem : elem;
  return {
    image,
    at,
    local,
    type: { kind: 'array', elem: own, count },
    init: image.init.map((v) => resign(v, elem.width / 8, own.signed)),
    string: image.string === true && elem.width === 8,
  };
}

/** How `body` reaches `local`: the constant indices of its direct element accesses, and whether
 *  anything reaches it other than as a whole call argument or a direct element access. */
function uses(body: readonly Stmt[], local: string): { indices: number[]; other: boolean } {
  let total = 0;
  let accounted = 0;
  const indices: number[] = [];
  for (const e of walkExprs(body as Stmt[])) {
    if (mentionedName(e) === local) {
      total++;
    }
    if (e.k === 'call' && e.args.some((a) => wholeObject(a) === local)) {
      accounted += e.args.filter((a) => wholeObject(a) === local).length;
    }
    if (e.k === 'index' && bare(e.base).k === 'var' && wholeObject(e.base) === local) {
      accounted++;
      const k = bare(e.idx);
      indices.push(k.k === 'const' ? k.value : 0);
    }
  }
  return { indices, other: total !== accounted };
}

/** Whether every anonymous image `sfn` holds folds into a local's initializer: null when it does,
 *  else the image's name and the tail of the sentence that refuses it. */
export function constantImageRefusal(sfn: SFn): { image: string; refused: string } | null {
  for (const image of sfn.statics ?? []) {
    if (image.anonymous) {
      const plan = planFold(sfn, image);
      if (typeof plan === 'string') {
        return { image: image.name, refused: plan };
      }
    }
  }
  return null;
}

/** `sfn` with every anonymous image folded into the initializer of the local its copy fills, the
 *  copy gone and the image with it. Throws where one does not fold: structure() refused that
 *  function already, so a tree that reaches here unfoldable was made so by a later pass. */
export function foldConstantImages(sfn: SFn): SFn {
  const images = (sfn.statics ?? []).filter((s) => s.anonymous);
  if (images.length === 0) {
    return sfn;
  }
  let out = sfn;
  for (const image of images) {
    const plan = planFold(out, image);
    if (typeof plan === 'string') {
      throw new Error(`cannot spell '${sfn.name}': the compiler's anonymous constant '${image.name}' ${plan}`);
    }
    out = {
      ...out,
      body: out.body.filter((_, i) => i !== plan.at),
      locals: out.locals.map((l) =>
        l.name === plan.local
          ? { ...l, type: plan.type, init: plan.init, ...(plan.string ? { initString: true as const } : {}) }
          : l,
      ),
      statics: (out.statics ?? []).filter((s) => s !== image),
    };
  }
  if (out.statics?.length === 0) {
    delete out.statics;
  }
  return out;
}
