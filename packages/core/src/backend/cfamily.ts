// asmlift — the SHARED C-family spelling. The L3 AST is language-neutral for the C-family:
// expression/statement nodes are neutral, and TYPE SPELLING is a backend decision (`cType`
// here, `pasType` in the Pascal backend). The empirical fact grounding the sharing: a
// CodeWarrior member function's BODY is byte-identical to the same C with `this` as an
// explicit pointer — so the C++ backend reuses this body spelling VERBATIM and owns only its
// DIVERGENT surface (the mangled/scoped signature, references, `this`). c.ts and cpp.ts
// consume exactly the exported seam: `emitCFamily` + `cType` + `LeafHook`.
import { IrType, T, scalarTypeForAccess, typeToString } from '../ir/types';
import { BinOp, Expr, SFn, Stmt, dotBase } from '../l3/ast';
import { type VarTypes, declaredTypes, derefStrideOk, exprCType } from '../l3/typing';

// C operator precedence (lower binds tighter). Used to emit MINIMAL parentheses. Shared: C++ has
// the same precedence for these operators.
const PREC: Record<BinOp, number> = {
  '*': 3,
  '/': 3,
  '%': 3,
  '+': 4,
  '-': 4,
  '<<': 5,
  '>>': 5,
  '<': 6,
  '<=': 6,
  '>': 6,
  '>=': 6,
  '==': 7,
  '!=': 7,
  '&': 8,
  '^': 9,
  '|': 10,
  '&&': 11,
  '||': 12,
};

/** Spell a recovered type in the decomp C-family typedef vocabulary (`s32`/`u32`/`u8`/`T *`). */
export function cType(t: IrType): string {
  if (t.kind === 'ptr') {
    return `${cType(t.to)} *`;
  }
  if (t.kind === 'struct') {
    return `struct ${t.name}`;
  }
  if (t.kind === 'array') {
    return `${cType(t.elem)}[${t.count}]`;
  } // ill-formed as a prefix; use cDeclare
  return typeToString(t); // s32 / u32 / u8 / unk32 (treated as s32 upstream)
}

/** Declare a name of a given type, C declarator rules: an array puts its length AFTER the name
 *  (`u8 _pad[4]`), everything else is the prefix `cType name`. */
function cDeclare(t: IrType, name: string): string {
  if (t.kind === 'array') {
    return `${cType(t.elem)} ${name}[${t.count}]`;
  }
  return `${cType(t)} ${name}`;
}

// A LEAF hook lets a C-family backend override how a `var` or `index` node spells WITHOUT
// re-implementing precedence, parenthesization, or statement structure. It returns the
// replacement text, or null to fall through to the default C spelling — how the C++ backend
// renders member access (`this->x` as bare `x`, `o->x`) over the exact same printer the C
// backend uses. The default (no hook) is byte-identical C.
export type LeafHook = (e: Expr, rec: (e: Expr, p: number) => string) => string | null;

function printExpr(e: Expr, parentPrec: number, vt: VarTypes, leaf?: LeafHook): string {
  const rec = (x: Expr, p: number) => printExpr(x, p, vt, leaf);
  if (leaf) {
    const s = leaf(e, rec);
    if (s !== null) {
      return s;
    }
  }
  // C-FAMILY LEGALIZATION (owned here, per the width-carrying `index` node contract in l3/ast.ts):
  // a deref whose base does not render as a pointer/array STRIDING the access width is spelled
  // through the honest reinterpret cast at that width — the machine semantics of the access.
  // Materialized as a synthetic cast node so the spelling (text, precedence, parens) is exactly
  // that of a tree-level cast.
  const legalized = (ix: Extract<Expr, { k: 'index' }>): Expr =>
    derefStrideOk(exprCType(ix.base, vt), ix.width)
      ? ix.base
      : { k: 'cast', to: T.ptr(scalarTypeForAccess(ix.width, ix.signed)), e: ix.base };
  switch (e.k) {
    case 'var':
      return e.name;
    case 'const':
      return String(e.value);
    case 'addr': {
      // `&gSym` — the address of a named global. A prefix operator; parenthesizes under a POSTFIX
      // parent like the other prefix forms.
      const g = `&${e.name}`;
      return parentPrec < 2 ? `(${g})` : g;
    }
    case 'call':
      return `${e.fn}(${e.args.map((a) => rec(a, 99)).join(', ')})`;
    case 'index': {
      // `*base` for the zero offset (a PREFIX operator, so a prefix-shaped base like a cast needs
      // no parens: `*(u8 *)p` — but the whole form must self-parenthesize under a POSTFIX parent:
      // `(*p)[1]`, never `*p[1]` which C groups as `*(p[1])`), `base[idx]` otherwise (POSTFIX —
      // binds tighter than any prefix operator, so a cast/unary/deref base is printed at prec 1
      // and parenthesizes itself: `((u8 *)p)[1]`). The postfix form needs no outer parentheses.
      const base = legalized(e);
      if (e.idx.k === 'const' && e.idx.value === 0) {
        const s = `*${rec(base, 2)}`;
        return parentPrec < 2 ? `(${s})` : s;
      }
      return `${rec(base, 1)}[${rec(e.idx, 99)}]`;
    }
    case 'field': {
      // `base->name`, or `base.name` when the base is itself an array element (a struct VALUE, not
      // a pointer) — an array-of-struct access `arr[i].field` (fieldSpellsDot, the shared rule).
      // Postfix (base at prec 1, exactly like `[]` above), no outer parens.
      //
      // The dot form's base index node is printed WITHOUT legalization: a struct-array element's
      // base is legalized at the TREE level (arrayAccess casts to the recovered struct pointer;
      // carrying the struct identity ON the node — like width — is the named follow-up), and the
      // width-cast legalization above must not double-wrap it. The leaf hook still sees the base
      // first (the C++ member-access rewrite).
      const ix = dotBase(e);
      if (ix) {
        const hooked = leaf?.(ix, rec);
        const baseTxt = hooked ?? `${rec(ix.base, 1)}[${rec(ix.idx, 99)}]`;
        return `${baseTxt}.${e.name}`;
      }
      // explicit dot: a struct-VALUE global's field (`gSym.field`, symbol-map layout spelling)
      if (e.dot) {
        return `${rec(e.base, 1)}.${e.name}`;
      }
      return `${rec(e.base, 1)}->${e.name}`;
    }
    case 'un': {
      // A prefix operator: parenthesize under a POSTFIX parent (`(-a)[1]`), and parenthesize a
      // same-op nested `-` (`-(-a)`, never `--a` — C lexes that as predecrement).
      const inner = rec(e.e, 2);
      const s = `${e.op}${e.op === '-' && inner.startsWith('-') ? `(${inner})` : inner}`;
      return parentPrec < 2 ? `(${s})` : s;
    }
    // A gap marker spells as a call to the UNDEFINED macro ASMLIFT_ERROR("reason", args…) — the
    // m2c M2C_ERROR discipline: the function is complete and readable, but a compile fails until
    // the user consciously defines the macro. Postfix/call-shaped, so no outer parens needed.
    case 'marker':
      return `ASMLIFT_ERROR(${[JSON.stringify(e.reason), ...e.args.map((a) => rec(a, 99))].join(', ')})`;
    // A C cast binds as a prefix operator (like unary), tighter than any binary op: the operand is
    // printed at prec 2, so `(u8)a & 1` needs no parens but `(u8)(a & 1)` gets them from the inner
    // op. Under a POSTFIX parent ([]/->) the cast itself must parenthesize — `((struct S *)p)->f`,
    // NOT `(struct S *)p->f` (which C parses as a cast OF the member access).
    case 'cast': {
      const s = `(${cType(e.to)})${rec(e.e, 2)}`;
      return parentPrec < 2 ? `(${s})` : s;
    }
    case 'bin': {
      const p = PREC[e.op];
      const s = `${rec(e.l, p)} ${e.op} ${rec(e.r, p - 1)}`;
      return p > parentPrec ? `(${s})` : s;
    }
  }
}

function printStmt(s: Stmt, indent: string, vt: VarTypes, leaf?: LeafHook): string[] {
  const pe = (e: Expr, p: number) => printExpr(e, p, vt, leaf);
  switch (s.k) {
    case 'assign':
      return [`${indent}${s.name} = ${pe(s.value, 99)};`];
    case 'store':
      // The lvalue is a full Expr (`index` or `field`), so the leaf hook spells a member write
      // (`this->x = …`) exactly as it spells a member read.
      return [`${indent}${pe(s.lval, 2)} = ${pe(s.value, 99)};`];
    case 'exprstmt':
      return [`${indent}${pe(s.value, 99)};`];
    case 'return':
      return [`${indent}return${s.value ? ' ' + pe(s.value, 99) : ''};`];
    case 'if': {
      const cond = pe(s.cond, 99);
      if (s.then.length === 1 && s.else.length === 0 && s.then[0].k !== 'if') {
        // Inline `if (c) stmt;` ONLY when the statement prints as a single line — a multi-line
        // then (a do-while/while/for/switch) taking just `[0]` here silently truncated the body.
        const inner = printStmt(s.then[0], '', vt, leaf);
        if (inner.length === 1) {
          return [`${indent}if (${cond}) ${inner[0].trim()}`];
        }
      }
      const out = [`${indent}if (${cond}) {`];
      for (const t of s.then) {
        out.push(...printStmt(t, indent + '    ', vt, leaf));
      }
      if (s.else.length) {
        out.push(`${indent}} else {`);
        for (const e of s.else) {
          out.push(...printStmt(e, indent + '    ', vt, leaf));
        }
      }
      out.push(`${indent}}`);
      return out;
    }
    case 'while': {
      const out = [`${indent}while (${pe(s.cond, 99)}) {`];
      for (const t of s.body) {
        out.push(...printStmt(t, indent + '    ', vt, leaf));
      }
      out.push(`${indent}}`);
      return out;
    }
    case 'dowhile': {
      const out = [`${indent}do {`];
      for (const t of s.body) {
        out.push(...printStmt(t, indent + '    ', vt, leaf));
      }
      out.push(`${indent}} while (${pe(s.cond, 99)});`);
      return out;
    }
    case 'for': {
      // `for (init; cond; inc) { body }`. PRECONDITION (guaranteed by the sole producer, structure.ts
      // `recognizeForLoops`): init/inc are each a SINGLE-LINE `assign` statement. `clause` renders one
      // and strips its trailing `;` so it sits inside the header (`i = 0; c; i = i + 1`). A multi-line
      // statement (an `if`/nested loop) would render mangled — but the recognizer never builds one here.
      const clause = (st: Stmt) => printStmt(st, '', vt, leaf).join(' ').replace(/;\s*$/, '').trim();
      const out = [`${indent}for (${clause(s.init)}; ${pe(s.cond, 99)}; ${clause(s.inc)}) {`];
      for (const t of s.body) {
        out.push(...printStmt(t, indent + '    ', vt, leaf));
      }
      out.push(`${indent}}`);
      return out;
    }
    case 'break':
      return [`${indent}break;`];
    case 'continue':
      return [`${indent}continue;`];
    case 'switch': {
      const out = [`${indent}switch (${pe(s.scrutinee, 99)}) {`];
      const ci = indent + '    '; // case-label indent
      const bi = indent + '        '; // case-body indent
      for (const c of s.cases) {
        for (const v of c.values) {
          out.push(`${ci}case ${v}:`);
        }
        for (const t of c.body) {
          out.push(...printStmt(t, bi, vt, leaf));
        }
        // A case whose body ends in `return`/`break` (a terminated arm) needs no `break;`; only an
        // open non-fall-through arm gets one. `fallsThrough` omits it so control drops to the next case.
        if (!c.fallsThrough && !endsTerminated(c.body)) {
          out.push(`${bi}break;`);
        }
      }
      if (s.default) {
        out.push(`${ci}default:`);
        for (const t of s.default) {
          out.push(...printStmt(t, bi, vt, leaf));
        }
      }
      out.push(`${indent}}`);
      return out;
    }
  }
}

// Does a statement list end in a control-flow terminator (so a trailing `break;` would be dead)?
function endsTerminated(body: Stmt[]): boolean {
  const last = body[body.length - 1];
  return (
    !!last &&
    (last.k === 'return' ||
      last.k === 'break' ||
      last.k === 'continue' ||
      (last.k === 'if' && endsTerminated(last.then) && last.else.length > 0 && endsTerminated(last.else)))
  );
}

/** The body of a C-family function: local declarations + statements, one string per line. The
 *  SIGNATURE (return type + name + params, plus any C++ scope/`this`/mangling) is the caller's —
 *  that is the language-divergent part each backend owns. */
// C-FAMILY WRITE LEGALIZATION (the assign-side sibling of the deref legalization in printExpr):
// a value whose rendered C type is definitely NON-pointer written into a pointer-declared slot
// (`v2 = a1 + v0` with `v2: u8 *`; `return a0 + v0` from a ptr-returning fn; `*pp = intexpr`
// through a pointer-element slot) is an ERROR on mwcc (gcc merely warns) — the honest spelling
// is the reinterpret cast to the DECLARED type, exactly what the machine's register move does.
// Unknowable renderings (calls) are left alone: their C type comes from prototypes outside this
// function. (A rebuilding transform with per-kind semantics — its own switch, per the l3/ast.ts
// traversal-vocabulary exemption.)
function legalizePointerWrites(fn: SFn): SFn {
  const vt = declaredTypes(fn);
  const castTo = (t: IrType | undefined, e: Expr): Expr => {
    if (t?.kind !== 'ptr') {
      return e;
    }
    const ct = exprCType(e, vt);
    return ct && ct.kind !== 'ptr' && ct.kind !== 'array' ? { k: 'cast', to: t, e } : e;
  };
  const fix = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign':
        return { ...s, value: castTo(vt(s.name), s.value) };
      case 'store': {
        // the slot's type is the lvalue's C element type (a pointer-element slot needs the cast)
        const slot = exprCType(s.lval, vt);
        return { ...s, value: castTo(slot, s.value) };
      }
      case 'return':
        return s.value ? { ...s, value: castTo(fn.retType, s.value) } : s;
      case 'if':
        return { ...s, then: s.then.map(fix), else: s.else.map(fix) };
      case 'while':
      case 'dowhile':
        return { ...s, body: s.body.map(fix) };
      case 'for':
        return { ...s, init: fix(s.init), inc: fix(s.inc), body: s.body.map(fix) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(fix) })),
          default: s.default ? s.default.map(fix) : undefined,
        };
      default:
        return s;
    }
  };
  return { ...fn, body: fn.body.map(fix) };
}

function cFamilyBody(fn0: SFn, leaf?: LeafHook): string[] {
  const fn = legalizePointerWrites(fn0);
  // The legalization env: every printed var's declared type, from the SAME params/locals the
  // emitted declarations come from — so the printer judges exactly the C the reader will see.
  const vt: VarTypes = declaredTypes(fn);
  const lines: string[] = [];
  for (const l of fn.locals) {
    lines.push(`    ${cType(l.type)} ${l.name};`);
  }
  for (const s of fn.body) {
    lines.push(...printStmt(s, '    ', vt, leaf));
  }
  return lines;
}

/** Struct declarations this function references, one `struct N { ... };` per recovered aggregate.
 *  The struct type is SELF-DESCRIBING: any padding needed to seat fields at their exact offsets is
 *  already present as real `u8[N]` pad fields — both raise/struct-arrays.ts (element strides) and
 *  raise/structs.ts (unaccessed leading/interior gaps) interleave them where natural C alignment
 *  does not already cover the offset. This just declares each field in order. */
function structDecls(fn: SFn): string[] {
  return (fn.structs ?? []).map(
    (s) => `struct ${s.name} { ${s.fields.map((f) => cDeclare(f.type, f.name) + ';').join(' ')} };`,
  );
}

/** Assemble a full C-family function from a caller-supplied signature line and the shared body. */
export function emitCFamily(signature: string, fn: SFn, leaf?: LeafHook): string {
  const decls = structDecls(fn);
  const preamble = decls.length ? decls.join('\n') + '\n' : '';
  return preamble + [`${signature} {`, ...cFamilyBody(fn, leaf), '}'].join('\n') + '\n';
}

// One C-family comment spelling, shared by the C and C++ backends. A `*` followed by `/`
// inside the text would terminate the comment early — split it.
export function cComment(text: string): string {
  return `/* ${text.replace(/\*\//g, '* /')} */`;
}
