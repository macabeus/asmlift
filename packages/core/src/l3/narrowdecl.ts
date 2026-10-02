// A NAMED NARROW VALUE, declared at its width: `s32 v; v = (u8)(x - 1);` becomes
// `u8 v; v = x - 1;`.
//
// The two spellings compute the same C value at every read. The declaration truncates where the
// cast did, and a `u8`, `s8`, `u16` or `s16` read is promoted to `int`, which is what an `s32` read
// already is, so no operator a read meets changes type. What changes is the object the compiler
// holds the value in, and agbcc allocates registers around it differently. Compiled with agbcc
// `-O2 -mthumb-interwork -fhex-asm -fprologue-bugfix`, both spellings of
//
//   v = g.c - 1;  h.d = (v & 1) + rnd() % (5 - v) + 1;
//
// load, subtract and zero-extend into the same register, but under `s32 v` the AND copies `v`
// first (`mov r1, #1; add r4, r5, #0; and r4, r4, r1`), where under `u8 v` it operates on it in
// place (`mov r5, #1; and r5, r5, r4`), which is what `kleod:sub_0803E8CC` holds. Where the two
// allocate alike, as on the `/derived-home` winner of `kleod:HBlankIntr_DeleteAllSaveDataScreen`,
// both compile to the same bytes.
//
// REFUSED, each because the two spellings would stop being the same program, or stop being one
// the asm can tell apart from the other's:
//   • a local that is not `s32`. A `u32` read is unsigned, and narrowing it would turn its compares,
//     divisions and shifts into signed ones;
//   • a local written more than once, or by `v++`. A second write is a loop's update or a merge's
//     arm, where the width decides the loop agbcc emits (raise/narrowlocal.ts), which this does
//     not weigh;
//   • a local whose one write is not a narrowing integer cast, or is a `for` loop's init;
//   • a local whose address is taken, or that is volatile, a frame object, uninitialized, or homed
//     in a stack slot. Each of those is an object in memory, whose width is its access width.
import type { IrType } from '../ir/types';
import { type Expr, type SFn, type Stmt, mapStmtLists } from './ast';
import { localMentions } from './mentions';

type Narrowing = Extract<Expr, { k: 'cast' }> & { to: Extract<IrType, { kind: 'int' }> };

const isNarrowing = (e: Expr): e is Narrowing =>
  e.k === 'cast' && !e.volatile && e.to.kind === 'int' && e.to.width < 32;

/** The tree with every local the header admits declared at its narrowing's width, or the tree
 *  itself when none is. */
export function narrowDeclarations(sfn: SFn): SFn {
  const mentions = localMentions(sfn);
  let body = sfn.body;
  const narrowed = new Map<string, IrType>();
  for (const l of sfn.locals) {
    const m = mentions.get(l.name);
    const declared = l.type;
    if (
      m === undefined ||
      m.assigns !== 1 ||
      m.addrTaken > 0 ||
      declared.kind !== 'int' ||
      declared.width !== 32 ||
      !declared.signed ||
      l.volatile ||
      l.pointeeVolatile ||
      l.frame ||
      l.uninit ||
      l.slots
    ) {
      continue;
    }
    let to: IrType | undefined;
    const rewrite = (list: Stmt[]): Stmt[] =>
      list.map((s) => {
        if (s.k === 'assign' && s.name === l.name && isNarrowing(s.value)) {
          to = s.value.to;
          return { ...s, value: s.value.e };
        }
        return mapStmtLists(s, rewrite);
      });
    const next = rewrite(body);
    if (to !== undefined) {
      body = next;
      narrowed.set(l.name, to);
    }
  }
  if (narrowed.size === 0) {
    return sfn;
  }
  return { ...sfn, body, locals: sfn.locals.map((l) => ({ ...l, type: narrowed.get(l.name) ?? l.type })) };
}
