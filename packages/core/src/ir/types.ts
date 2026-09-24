// asmlift IR — semantic types. NOT language type strings (a hard requirement from
// the language-backend study: each backend picks its own spelling from these).

/** One recovered field of a struct: its byte offset within the struct, its recovered
 *  scalar/pointer type, and its (currently synthetic, offset-derived) name. */
export interface StructField {
  off: number;
  type: IrType;
  name: string;
}

export type IrType =
  | { kind: 'unknown'; width: number } // width in bits; type not yet recovered
  | { kind: 'int'; width: number; signed: boolean }
  | { kind: 'ptr'; to: IrType }
  // A recovered aggregate: heterogeneous fields at byte offsets (raise/structs.ts). Distinct
  // from `ptr(int)`+array-index because its access pattern is inconsistent with a homogeneous
  // array (mixed widths / non-uniform offsets). `name` is synthetic today (`Struct0`); a later
  // DWARF pass supplies real names. Fields are sorted by `off`.
  | { kind: 'struct'; name: string; fields: StructField[]; size?: number }
  // A fixed-length array `elem[count]`. Today its sole inhabitant is struct padding (a `u8[N]`
  // pad member seats fields at their exact offsets, raise/struct-arrays.ts) — a REAL type,
  // not a printed string. Array-typed fields declare with the length AFTER the name in C
  // (`u8 _pad[4]`), so the backend routes them through a declarator-aware `cDeclare`, not the
  // prefix `cType`.
  | { kind: 'array'; elem: IrType; count: number }
  // Several VIEWS of one storage cell (raise/structs.ts): a base read or written at more than one
  // width or extension over the same bytes. Every member sits at offset 0. It carries no name
  // because it is only ever declared INLINE, as the type of the struct member that holds it, and its
  // `size` is the one the target's compiler gives it — which is not always its widest view
  // (`T.union` computes it from the compiler's aggregate boundary).
  | { kind: 'union'; members: StructField[]; size: number }
  | { kind: 'void' }; // a function that returns nothing

/** The scalar type of a memory access of `width` bytes: word ⇒ the s32 integer default;
 *  narrower widths carry the access's signedness. THE one copy of a match-critical rule (it
 *  decides emitted decl types), consumed by recover.ts, structs.ts, and struct-arrays — a
 *  per-consumer copy would silently diverge struct fields from pointer pointees. */
export function scalarTypeForAccess(width: number, signed: boolean): IrType {
  return width === 4 ? T.s(32) : T.int(width * 8, signed);
}

/** The width in bits of the integer a type carries, or null where a type carries no integer. A
 *  pointer's own width is the machine's and says nothing about what it addresses; an aggregate and
 *  `void` have no single width at all. `unknown` DOES carry one, which is the point — before type
 *  recovery every value is `unknown`, so a rule that skipped that kind would be vacuous exactly
 *  where the frontends build these.
 *
 *  THE one copy, for the reason `scalarTypeForAccess` above is: its two consumers read the same
 *  question under OPPOSITE policies, and a per-consumer copy is how they drift apart. `ir/verify.ts`
 *  reads null as "this type does not take part in the width rule, so pass"; `runtime-helpers.ts`
 *  reads null as "this operand carries no integer width, so refuse to fold a 64-bit operation over
 *  it". Both want exactly this predicate — a pointer handed to `__muldi3` has no width either of
 *  them may claim — so an `IrType` kind added here reaches the verifier and the recogniser together
 *  or neither. */
export function intWidth(t: IrType): number | null {
  return t.kind === 'int' || t.kind === 'unknown' ? t.width : null;
}

export const T = {
  unk: (width = 32): IrType => ({ kind: 'unknown', width }),
  int: (width: number, signed: boolean): IrType => ({ kind: 'int', width, signed }),
  s: (width = 32): IrType => ({ kind: 'int', width, signed: true }),
  u: (width = 32): IrType => ({ kind: 'int', width, signed: false }),
  ptr: (to: IrType): IrType => ({ kind: 'ptr', to }),
  struct: (name: string, fields: StructField[], size?: number): IrType => ({ kind: 'struct', name, fields, size }),
  array: (elem: IrType, count: number): IrType => ({ kind: 'array', elem, count }),
  union: (members: StructField[], boundary: number): IrType => ({
    kind: 'union',
    members,
    size: Math.max(boundary, ...members.map((m) => (m.type.kind === 'array' ? m.type.count : 1) * viewBytes(m.type))),
  }),
  void: (): IrType => ({ kind: 'void' }),
};

/** The byte width of a union view's element (an array view's element, or the scalar itself). */
function viewBytes(t: IrType): number {
  const e = t.kind === 'array' ? t.elem : t;
  return (intWidth(e) ?? 32) / 8;
}

/** The member `name` of an aggregate — a struct's field or a union's view — or undefined when `t`
 *  is not an aggregate or declares no such member. THE one lookup the typing walk and the deref
 *  contract share, so the two cannot disagree on which member access is well-typed. */
export function memberOf(t: IrType | undefined, name: string): StructField | undefined {
  if (t?.kind === 'struct') {
    return t.fields.find((f) => f.name === name);
  }
  if (t?.kind === 'union') {
    return t.members.find((m) => m.name === name);
  }
  return undefined;
}

/** The union member of a struct that holds byte `off`, and the view of it an access of `width`
 *  bytes reads — the view of that width, and where a width has two views (a signed and an unsigned
 *  one) the one of the load's own extension, or the unsigned one for a store, which carries none —
 *  with the element index inside an ARRAY view (null for a scalar one). Undefined when no union
 *  member holds `off`; `view` undefined when the member has no view that wide. */
export function unionViewAt(
  st: Extract<IrType, { kind: 'struct' }>,
  off: number,
  width: number,
  signed: boolean,
  isStore: boolean,
): { member: StructField; view: StructField | undefined; index: number | null } | undefined {
  const member = st.fields.find((f) => f.type.kind === 'union' && f.off <= off && off < f.off + f.type.size);
  if (member === undefined || member.type.kind !== 'union') {
    return undefined;
  }
  const elemOf = (t: IrType): IrType => (t.kind === 'array' ? t.elem : t);
  const wide = member.type.members.filter((m) => intWidth(elemOf(m.type)) === width * 8);
  // A width with ONE view is read and written through it: raise/structs.ts made it for every
  // extension that width was loaded with.
  const view =
    wide.length > 1
      ? wide.find((m) => {
          const e = elemOf(m.type);
          return e.kind === 'int' && e.signed === (isStore ? false : signed);
        })
      : wide[0];
  return { member, view, index: view?.type.kind === 'array' ? (off - member.off) / width : null };
}

export function typeToString(t: IrType): string {
  switch (t.kind) {
    case 'unknown':
      return `unk${t.width}`;
    case 'int':
      return `${t.signed ? 's' : 'u'}${t.width}`;
    case 'ptr':
      return `${typeToString(t.to)}*`;
    case 'struct':
      return t.name;
    case 'array':
      return `${typeToString(t.elem)}[${t.count}]`;
    case 'union':
      return `union{${t.members.map((m) => `${typeToString(m.type)} ${m.name}`).join(';')}}`;
    case 'void':
      return 'void';
  }
}

export function parseType(s: string): IrType {
  s = s.trim();
  if (s.endsWith('*')) {
    return T.ptr(parseType(s.slice(0, -1)));
  }
  const m = s.match(/^(unk|s|u)(\d+)$/);
  if (!m) {
    throw new Error(`bad type '${s}'`);
  }
  const width = parseInt(m[2], 10);
  if (m[1] === 'unk') {
    return T.unk(width);
  }
  return T.int(width, m[1] === 's');
}

export function typeEquals(a: IrType, b: IrType): boolean {
  if (a.kind === 'ptr' && b.kind === 'ptr') {
    return typeEquals(a.to, b.to);
  }
  if (a.kind === 'int' && b.kind === 'int') {
    return a.width === b.width && a.signed === b.signed;
  }
  if (a.kind === 'unknown' && b.kind === 'unknown') {
    return a.width === b.width;
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return a.count === b.count && typeEquals(a.elem, b.elem);
  }
  if (a.kind === 'union' && b.kind === 'union') {
    return (
      a.size === b.size &&
      a.members.length === b.members.length &&
      a.members.every((m, i) => m.name === b.members[i].name && typeEquals(m.type, b.members[i].type))
    );
  }
  // Two structs are equal when their name + field layout match (recovered structs are named
  // by layout-discovery order, so equal name ⇒ equal layout in practice).
  if (a.kind === 'struct' && b.kind === 'struct') {
    return (
      a.name === b.name &&
      a.fields.length === b.fields.length &&
      a.fields.every(
        (f, i) => f.off === b.fields[i].off && f.name === b.fields[i].name && typeEquals(f.type, b.fields[i].type),
      )
    );
  }
  return false;
}
