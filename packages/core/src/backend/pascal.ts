// asmlift — the IDO / SGI Pascal backend. Consumes the SAME
// language-neutral L3 AST as the C backend; every divergence lives here: `:=` assignment,
// `if..then..else`, and the neutral "return a value" node lowered to Pascal's name-assignment
// idiom (`FnName := expr`).
//
// DIALECT NOTE (verified against IDO 7.1 `upas`): in SGI Pascal `and`/`or`/`not` are BOOLEAN
// operators — using them on integers is a type error ("operand(s) must be boolean"). Bitwise
// and shift operations are INTRINSIC FUNCTIONS: bitand/bitor/bitxor/bitnot and lshift/rshift.
// (`rshift` is arithmetic on a signed Integer → `sra`.) This is the concrete difference from
// Turbo/Delphi/FreePascal.
import { IrType, typeToString } from '../ir/types';
import { BinOp, Expr, LanguageBackend, SFn, Stmt } from '../l3/ast';
import { type VarTypes, declaredTypes, derefStrideOk, exprCType } from '../l3/typing';

// Infix operators IDO Pascal spells directly.
const OP: Partial<Record<BinOp, string>> = {
  // NOTE: no `%`. IDO Pascal `mod` is ISO (result in [0, n), sign of the DIVISOR), which does NOT
  // match C's truncated `%` (sign of the DIVIDEND) — verified: `a mod 3` mis-scores against the
  // IDO C `a % 3` codegen. There is no faithful IDO-Pascal spelling of a signed C remainder, so the
  // backend fails LOUD on `%` (below) rather than emit a silently-wrong `mod`. `/`→`div` DOES match.
  '+': '+',
  '-': '-',
  '*': '*',
  '/': 'div',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '==': '=',
  '!=': '<>',
};
// Bitwise/shift operations that IDO Pascal spells as intrinsic FUNCTION calls `fn(l, r)`.
const BIT_FN: Partial<Record<BinOp, string>> = {
  '&': 'bitand',
  '|': 'bitor',
  '^': 'bitxor',
  '<<': 'lshift',
  '>>': 'rshift',
};

function pasType(t: IrType): string {
  if (t.kind === 'ptr') {
    return '^' + pasType(t.to);
  }
  if (t.kind === 'int') {
    return t.signed ? 'Integer' : 'Cardinal';
  }
  // `unknown` reaching a backend means recovery's totality contract already failed upstream —
  // spell it Integer (assertTypesRecovered is the real gate). struct/array have NO faithful
  // spelling here yet — fail loud, like every other unspellable construct in this backend. A
  // void RETURN type is deliberately spelled as `procedure` (see emit) and never reaches here.
  if (t.kind === 'unknown') {
    return 'Integer';
  }
  throw new Error(`pascal backend: no faithful spelling for a ${t.kind}-typed value yet`);
}

// Pascal precedence is paren-hungry and differs from C; emit parens around every nested
// binary/unary subexpression (always safe). Minimal-paren Pascal is a later refinement.
//
// pe/ps live in a factory closing over `vt` (the declared type of each printed variable) so the
// deref check below can judge the Pascal the reader will see without threading an argument
// through every recursion site.
function makePrinter(vt: VarTypes) {
  function pe(e: Expr): string {
    switch (e.k) {
      case 'var':
        return e.name;
      case 'addr':
        // IDO Pascal address-of has no faithful spelling here yet — loud-decline (agbcc-only
        // globals today; a deref of an addr is simplified away before it reaches this backend).
        throw new Error(`pascal backend: address-of global '${e.name}' has no IDO Pascal spelling yet`);
      case 'const':
        return String(e.value);
      case 'call':
        return `${e.fn}(${e.args.map(pe).join(', ')})`;
      case 'index': {
        // The width-carrying access node (l3/ast.ts): each backend legalizes its own derefs. The
        // C family inserts a reinterpret cast when the base's rendered type does not stride the
        // access width; Pascal HAS no reinterpret cast, so a definite mismatch declines LOUD — a
        // `p^` through the wrong-width pointer would silently read the wrong size. An UNKNOWABLE
        // base (a call — its type lives outside this unit) prints ONLY for a word access, where
        // any plausible `^Integer`-shaped callee agrees with the machine width; a sub-word access
        // through an unknowable base would DISCARD the node's width (upas checks types, not
        // machine widths), so it declines like a definite mismatch.
        const bt = exprCType(e.base, vt);
        if ((bt !== undefined && !derefStrideOk(bt, e.width)) || (bt === undefined && e.width !== 4)) {
          throw new Error(
            `pascal backend: a ${e.width}-byte access through a base of type '${bt ? typeToString(bt) : '<unknowable>'}' has no faithful spelling (no reinterpret cast)`,
          );
        }
        return e.idx.k === 'const' && e.idx.value === 0 ? `${pe(e.base)}^` : `${pe(e.base)}[${pe(e.idx)}]`;
      }
      // Recovered struct field access has no faithful IDO-Pascal spelling yet (records + `.field`
      // are future work) — fail LOUD rather than emit a silently-wrong access, as `%` does above.
      case 'field':
        throw new Error(`pascal backend: struct field access '${e.name}' has no IDO Pascal spelling yet`);
      case 'un':
        return e.op === '~' ? `bitnot(${pe(e.e)})` : `(${e.op === '!' ? 'not ' : e.op}${pe(e.e)})`;
      // Casts have no faithful IDO-Pascal spelling yet — fail LOUD rather than emit silently-wrong
      // source. Tree-level producers reaching here: the width-narrowing idiom casts (agbcc-gated,
      // so never on this path today), structure.ts's STRUCT-pointer casts (unreachable too — the
      // `field` case above throws first), and intify's `(s32)ptr` legalization (any target).
      // Scalar deref casts never appear in the tree — the index case above owns that judgment.
      case 'cast':
        throw new Error(`pascal backend: cast has no IDO Pascal spelling yet`);
      // A gap marker: a call to the UNDECLARED function ASMLIFT_ERROR — Pascal has no preprocessor,
      // but an undeclared identifier fails `upas` all the same, so the loud-in-artifact property
      // (the file cannot compile until the user consciously supplies the symbol) is preserved.
      // Single quotes double to escape inside a Pascal string literal.
      case 'marker':
        return `ASMLIFT_ERROR(${[`'${e.reason.replace(/'/g, "''")}'`, ...e.args.map(pe)].join(', ')})`;
      case 'bin': {
        const fn = BIT_FN[e.op];
        if (fn) {
          return `${fn}(${pe(e.l)}, ${pe(e.r)})`;
        }
        const op = OP[e.op];
        // Fail LOUD on an operator this backend cannot faithfully spell (e.g. `%`) rather than emit
        // `(l undefined r)` — a silently-wrong Pascal expression.
        if (!op) {
          throw new Error(`pascal backend: operator '${e.op}' has no faithful IDO Pascal spelling`);
        }
        return `(${pe(e.l)} ${op} ${pe(e.r)})`;
      }
    }
  }

  // `tail` = control falls off the END of the function once this statement (the LAST of its list)
  // completes. Pascal has no early return — `fnName := v` only sets the result — so a `return` is
  // faithful ONLY in tail position (the assignment-then-fall-off-end idiom; a bare tail `return;`
  // simply falls off). A NON-tail return would render as a silent fall-through miscompile, so it
  // fails LOUD, mirroring this file's `%`/`field`/`break` throws.
  function ps(fnName: string, s: Stmt, indent: string, tail = false): string[] {
    // render a statement list: only its LAST statement can inherit tail position
    const list = (stmts: Stmt[], ind: string, tl: boolean): string[] =>
      stmts.flatMap((x, i) => ps(fnName, x, ind, tl && i === stmts.length - 1));
    switch (s.k) {
      case 'assign': {
        // The write-side sibling of the index case's deref discipline: Pascal has no reinterpret
        // cast, so a definitely-non-pointer value assigned into a pointer-declared var (the shape
        // the C family legalizes with `(u8 *)…`, cfamily.ts legalizePointerWrites) declines LOUD
        // here instead of failing three stages later in upas.
        const dt = vt(s.name);
        const ct = exprCType(s.value, vt);
        if (dt?.kind === 'ptr' && ct && ct.kind !== 'ptr' && ct.kind !== 'array') {
          throw new Error(
            `pascal backend: assigning a ${typeToString(ct)} value into pointer var '${s.name}' has no faithful spelling (no reinterpret cast)`,
          );
        }
        return [`${indent}${s.name} := ${pe(s.value)};`];
      }
      case 'store':
        return [`${indent}${pe(s.lval)} := ${pe(s.value)};`];
      case 'exprstmt':
        return [`${indent}${pe(s.value)};`];
      case 'return':
        if (!tail) {
          throw new Error('pascal backend: early `return` (not in tail position) has no faithful IDO Pascal spelling');
        }
        return s.value ? [`${indent}${fnName} := ${pe(s.value)};`] : [];
      case 'if': {
        const cond = pe(s.cond);
        const block = (stmts: Stmt[], ind: string) =>
          stmts.length === 1
            ? ps(fnName, stmts[0], ind, tail)
            : [`${ind}begin`, ...list(stmts, ind + '  ', tail), `${ind}end`];
        // Pascal: no `;` before `else`; the branch statements already carry their own.
        const out = [`${indent}if ${cond} then`];
        out.push(...block(s.then, indent + '  '));
        if (s.else.length) {
          out.push(`${indent}else`);
          out.push(...block(s.else, indent + '  '));
        }
        return out;
      }
      case 'while': {
        // loop bodies are NEVER tail position — control returns to the test
        const body =
          s.body.length === 1
            ? ps(fnName, s.body[0], indent + '  ')
            : [`${indent}begin`, ...s.body.flatMap((x) => ps(fnName, x, indent + '  ')), `${indent}end`];
        return [`${indent}while ${pe(s.cond)} do`, ...body];
      }
      case 'dowhile':
        // IDO/SGI Pascal `repeat S until C` runs the body once then tests — the exit test is the NEGATION
        // of the C loop-continue condition (`do{}while(c)` re-enters while c is TRUE; `repeat until` exits
        // when its test is TRUE). `repeat`/`until` need no begin/end (the keywords bracket the body).
        return [
          `${indent}repeat`,
          ...s.body.flatMap((x) => ps(fnName, x, indent + '  ')),
          `${indent}until ${pe({ k: 'un', op: '!', e: s.cond })};`,
        ];
      case 'for':
        // IDO/SGI Pascal's native `for i := a to b do` is restricted to a unit-stride countable
        // range, so rather than pattern-match that subset, render the ALWAYS-faithful desugaring
        // `init; while cond do begin body; inc end` (reusing the `while` arm). The `for` node
        // exists purely as a C/C++ readability spelling — no silently-wrong `to`-bound. (A native
        // `for` spelling is future work.)
        return [
          ...ps(fnName, s.init, indent),
          ...ps(fnName, { k: 'while', cond: s.cond, body: [...s.body, s.inc] }, indent),
        ];
      // SGI/IDO Pascal has no loop `break`/`continue` — loud-fail rather than emit silently-wrong control
      // flow (mirrors the `field`/`cast`/`%` throws). A `goto`-lowered form is future work.
      case 'break':
        throw new Error('pascal backend: `break` has no IDO Pascal spelling');
      case 'continue':
        throw new Error('pascal backend: `continue` has no IDO Pascal spelling');
      case 'switch': {
        // IDO/SGI Pascal `case E of L: S; … otherwise S end`. There is NO fall-through in Pascal case-of,
        // so a `fallsThrough` arm has no faithful spelling → loud-fail (mirrors the `field`/`cast`/`%`
        // throws above). Each arm's body is a single statement or a begin/end block.
        const arm = (body: Stmt[], ind: string) =>
          body.length === 1
            ? ps(fnName, body[0], ind + '  ')
            : [`${ind}  begin`, ...body.flatMap((x) => ps(fnName, x, ind + '  ')), `${ind}  end`];
        // Pascal has no early `return`: a `return v` inside a case renders `fnName := v` and then FALLS
        // THROUGH the case-of into any post-switch code — a silent miscompile for a mixed return/break
        // switch. Loud-fail if a case (or default) body contains a return, rather than emit wrong code.
        const hasReturn = (body: Stmt[]): boolean =>
          body.some(
            (st) =>
              st.k === 'return' ||
              (st.k === 'if' && (hasReturn(st.then) || hasReturn(st.else))) ||
              ((st.k === 'while' || st.k === 'dowhile' || st.k === 'for') && hasReturn(st.body)) ||
              (st.k === 'switch' && (st.cases.some((c) => hasReturn(c.body)) || hasReturn(st.default ?? []))),
          );
        if (s.cases.some((c) => hasReturn(c.body)) || hasReturn(s.default ?? [])) {
          throw new Error(
            'pascal backend: `return` inside a switch case has no faithful IDO Pascal spelling (no early return)',
          );
        }
        const out = [`${indent}case ${pe(s.scrutinee)} of`];
        for (const c of s.cases) {
          if (c.fallsThrough) {
            throw new Error('pascal backend: switch fall-through has no faithful IDO Pascal case-of spelling');
          }
          out.push(`${indent}  ${c.values.join(', ')}:`, ...arm(c.body, indent + '  '));
        }
        if (s.default) {
          out.push(`${indent}  otherwise`);
          out.push(...arm(s.default, indent + '  '));
        }
        out.push(`${indent}end;`);
        return out;
      }
    }
  }
  return ps;
}

export const pascalBackend: LanguageBackend = {
  id: 'pascal',
  emit(fn: SFn): string {
    // Same env discipline as the C family (cfamily.ts cFamilyBody): the printer judges derefs
    // against the exact declarations it emits.
    const ps = makePrinter(declaredTypes(fn));
    const params = fn.params.map((p) => `${p.name}: ${pasType(p.type)}`).join('; ');
    // A void return is a PROCEDURE — the honest Pascal spelling (the annotate-mode stub's SFn is
    // void-typed by design); a valued function keeps the `function … : T` form.
    const lines = [
      fn.retType.kind === 'void'
        ? `procedure ${fn.name}(${params});`
        : `function ${fn.name}(${params}): ${pasType(fn.retType)};`,
    ];
    if (fn.locals.length) {
      lines.push('var', ...fn.locals.map((l) => `  ${l.name}: ${pasType(l.type)};`));
    }
    lines.push('begin');
    fn.body.forEach((s, i) => lines.push(...ps(fn.name, s, '  ', i === fn.body.length - 1)));
    lines.push('end;');
    return lines.join('\n') + '\n';
  },
  // ISO/IDO Pascal comment; `*)` inside the text would terminate it early — split it.
  comment(text: string): string {
    return `(* ${text.replace(/\*\)/g, '* )')} *)`;
  },
};
