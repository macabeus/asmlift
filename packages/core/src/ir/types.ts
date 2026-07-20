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
  | { kind: 'void' }; // a function that returns nothing

/** The scalar type of a memory access of `width` bytes: word ⇒ the s32 integer default;
 *  narrower widths carry the access's signedness. THE one copy of a match-critical rule (it
 *  decides emitted decl types), consumed by recover.ts, structs.ts, and struct-arrays — a
 *  per-consumer copy would silently diverge struct fields from pointer pointees. */
export function scalarTypeForAccess(width: number, signed: boolean): IrType {
  return width === 4 ? T.s(32) : T.int(width * 8, signed);
}

export const T = {
  unk: (width = 32): IrType => ({ kind: 'unknown', width }),
  int: (width: number, signed: boolean): IrType => ({ kind: 'int', width, signed }),
  s: (width = 32): IrType => ({ kind: 'int', width, signed: true }),
  u: (width = 32): IrType => ({ kind: 'int', width, signed: false }),
  ptr: (to: IrType): IrType => ({ kind: 'ptr', to }),
  struct: (name: string, fields: StructField[], size?: number): IrType => ({ kind: 'struct', name, fields, size }),
  array: (elem: IrType, count: number): IrType => ({ kind: 'array', elem, count }),
  void: (): IrType => ({ kind: 'void' }),
};

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
