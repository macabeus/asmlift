// asmlift L3 — the REGISTER-COPY re-spelling, a differ-ranked representation lever (the fourth,
// after signedness / branch sense / walk-vs-index).
//
// A compiler's register allocation leaves SOURCE-visible footprints the coalescing structurer
// legitimately erases: a phi materialized as an unconditional copy plus an IN-PLACE update on
// one arm (`adds r1, r0, #0; …; adds r1, #255` — thumb's 2-operand add-immediate REQUIRES the
// in-place form for imm > 7), a big constant staged in its own register before use, a return
// value built in a register other than the one it was computed in. Whether the source spelled
// the coalesced or the copy-carrying form is genuinely ambiguous from asm — so BOTH are emitted
// as candidates and the objdiff score referees (measured: the copy-carrying spelling is
// byte-exact on kleod's MultiplyQ8/Q4 + ReciprocalQ8/Q4 and pokeemerald's MathUtil_Mul16,
// where the coalesced form scores 3–4).
//
// Three composable rewrites, all decline-over-approximate (a shape outside the template is left
// untouched; if nothing fires, no candidate is emitted). SCOPE (adversarially learned): R1 fires
// ONLY in the top-level statement list — under a loop the "downstream rename" is temporally
// unsound (the next iteration reads the phi var BEFORE the diamond; reproduced as a wrong
// candidate outscoring a correct sibling), and under any nesting the rename cannot see the
// enclosing continuation. R2 fires only on top-level assign/return statements. Fresh vars use
// the `w*` space (pipeline naming is a*/v*/t*, reindex reserves i*), collide-checked.
//   R1 — diamond → copy + in-place update: `if (cmp(E, K0)) { v = E } else { v = E ⊕ K }` (either
//        arm order; E deep-equal and PURE — no calls/derefs/markers) becomes
//        `v = E; w = v; if (cmp'(w, K0)) { w = w ⊕ K }` with every LATER use of `v` renamed to
//        `w` (the phi variable split from the value variable — the machine's copy).
//   R2 — constant-expression staging: a const-only subtree (depth ≥ 1, e.g. `128 << 9`) used as
//        a bin operand materializes into its own fresh local first (`v = 128 << 9; … v / x …`) —
//        the register the compiler staged the constant in.
//   R3 — return assign-back: a non-var return expression lands in a fresh local first
//        (`r = E; return r`). Emitted as a SEPARATE variant (with/without R3) when R1/R2 fired:
//        which tail the source spelled is itself ambiguous.
import { IrType, T } from '../ir/types';
import { Expr, SFn, Stmt, exprEquals, mapExprChildren } from './ast';
import { declaredTypes, exprCType } from './typing';

const exprEq = exprEquals;

/** PURE = re-evaluable and hoistable: vars, consts, arithmetic, casts. No calls (effects), no
 *  derefs (memory order), no markers. */
function isPure(e: Expr): boolean {
  switch (e.k) {
    case 'var':
    case 'const':
      return true;
    case 'un':
    case 'cast':
      return isPure(e.e);
    case 'bin':
      return isPure(e.l) && isPure(e.r);
    default:
      return false;
  }
}

/** Every mention of var `from` in an expr renamed to `to`. */
function renameVar(e: Expr, from: string, to: string): Expr {
  if (e.k === 'var') {
    return e.name === from ? { k: 'var', name: to } : e;
  }
  return mapExprChildren(e, (c) => renameVar(c, from, to));
}

function renameInStmt(s: Stmt, from: string, to: string): Stmt {
  const rx = (e: Expr): Expr => renameVar(e, from, to);
  switch (s.k) {
    case 'assign':
      return { ...s, name: s.name === from ? to : s.name, value: rx(s.value) };
    case 'store':
      return { ...s, lval: rx(s.lval), value: rx(s.value) };
    case 'exprstmt':
      return { ...s, value: rx(s.value) };
    case 'return':
      return s.value ? { ...s, value: rx(s.value) } : s;
    case 'if':
      return {
        ...s,
        cond: rx(s.cond),
        then: s.then.map((x) => renameInStmt(x, from, to)),
        else: s.else.map((x) => renameInStmt(x, from, to)),
      };
    case 'while':
    case 'dowhile':
      return { ...s, cond: rx(s.cond), body: s.body.map((x) => renameInStmt(x, from, to)) };
    case 'for':
      return {
        ...s,
        init: renameInStmt(s.init, from, to),
        cond: rx(s.cond),
        inc: renameInStmt(s.inc, from, to),
        body: s.body.map((x) => renameInStmt(x, from, to)),
      };
    case 'switch':
      return {
        ...s,
        scrutinee: rx(s.scrutinee),
        cases: s.cases.map((c) => ({ ...c, body: c.body.map((x) => renameInStmt(x, from, to)) })),
        default: s.default ? s.default.map((x) => renameInStmt(x, from, to)) : undefined,
      };
    case 'break':
    case 'continue':
      return s;
  }
}

const FLIP: Record<string, string> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' };

/** A const-only tree of depth ≥ 1 (`128 << 9`, `-(1 << 4)`) — the staged-constant shape. */
function isConstExpr(e: Expr): boolean {
  switch (e.k) {
    case 'const':
      return true;
    case 'un':
      return isConstExpr(e.e);
    case 'bin':
      return isConstExpr(e.l) && isConstExpr(e.r);
    default:
      return false;
  }
}

/** Apply the register-copy re-spelling. Returns 0–2 variant SFns (without/with the R3 tail);
 *  empty when nothing fired. Pure — never mutates the input. */
export function registerishSpellings(sfn: SFn): SFn[] {
  const locals = [...sfn.locals];
  const taken = new Set([...sfn.params, ...sfn.locals].map((x) => x.name));
  let fresh = 0;
  const freshVar = (type: IrType): string => {
    let name = `w${fresh++}`;
    while (taken.has(name)) {
      name = `w${fresh++}`;
    }
    taken.add(name);
    locals.push({ name, type });
    return name;
  };
  const typeOf = (name: string): IrType => [...sfn.params, ...locals].find((x) => x.name === name)?.type ?? T.s(32);

  let fired = 0;
  // R1's value var — DEAD after the copy (every later read renamed to w), so R3 REUSES it for
  // the tail: gcc 2.9's allocator is sensitive to the live-name count, and a fresh tail var
  // scored 3 where the reused one scored 0 (measured on MultiplyQ8).
  let deadValueVar: string | null = null;

  // R1 over a statement list: rewrite the diamond and rename v→w in every LATER statement.
  const r1List = (stmts: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (s.k === 'if' && s.then.length === 1 && s.else.length === 1) {
        const m = matchDiamond(s);
        if (m) {
          const { v, E, updArm, upd, cond } = m;
          // GUARDS BEFORE ALLOCATION (a declined shape must leave no residue — the leaked
          // dead `w` even perturbed the live-name count this lever exists to reproduce):
          //   • E and the cond pure; the cond's non-E operand must NOT mention v (a clamp's
          //     `if (a < v)` would compare against the POST-assignment v — reproduced);
          //   • the copy w carries E's RENDERED type, not v's declared one (retyping a u32
          //     comparison signed flipped its sense — reproduced).
          if (!isPure(E) || !isPure(cond) || condOtherMentions(cond, E, v)) {
            out.push(s);
            continue;
          }
          const wType = exprCType(E, declaredTypes({ ...sfn, locals })) ?? typeOf(v);
          const w = freshVar(wType);
          const condOnW = rewriteCond(cond, E, w);
          if (condOnW) {
            const flipped = updArm === 'else' ? flipCmp(condOnW) : condOnW;
            if (flipped) {
              out.push({ k: 'assign', name: v, value: E });
              out.push({ k: 'assign', name: w, value: { k: 'var', name: v } });
              out.push({
                k: 'if',
                cond: flipped,
                then: [{ k: 'assign', name: w, value: renameVar(renameSubexpr(upd, E, v), v, w) }],
                else: [],
              });
              // every LATER statement reads the phi var under its new name
              const rest = stmts.slice(i + 1).map((x) => renameInStmt(x, v, w));
              out.push(...r1List(rest));
              fired++;
              deadValueVar = v;
              return out;
            }
          }
        }
      }
      out.push(s); // nested constructs are NOT rewritten — see the SCOPE note
    }
    return out;
  };

  interface Diamond {
    v: string;
    E: Expr;
    updArm: 'then' | 'else';
    upd: Expr;
    cond: Expr;
  }
  /** `if (cmp) { v = E } else { v = f(E) }` (or arms swapped), f = bin(E, const-ish). */
  function matchDiamond(s: Extract<Stmt, { k: 'if' }>): Diamond | null {
    if (s.then.length !== 1 || s.else.length !== 1) {
      return null;
    }
    const a = s.then[0];
    const b = s.else[0];
    if (a.k !== 'assign' || b.k !== 'assign' || a.name !== b.name) {
      return null;
    }
    const isUpdOf = (upd: Expr, base: Expr): boolean =>
      upd.k === 'bin' && isPure(upd.r) && exprEq(upd.l, base) && isConstExpr(upd.r);
    if (isUpdOf(b.value, a.value)) {
      return { v: a.name, E: a.value, updArm: 'else', upd: b.value, cond: s.cond };
    }
    if (isUpdOf(a.value, b.value)) {
      return { v: a.name, E: b.value, updArm: 'then', upd: a.value, cond: s.cond };
    }
    return null;
  }
  /** Does the cond's NON-E operand mention `v`? (The E side becomes the copy; the other side
   *  must be v-free or the hoisted assignment changes what it compares against.) */
  function condOtherMentions(cond: Expr, E: Expr, v: string): boolean {
    if (cond.k !== 'bin') {
      return false;
    }
    const other = exprEq(cond.l, E) ? cond.r : exprEq(cond.r, E) ? cond.l : null;
    const mentions = (e: Expr): boolean => {
      if (e.k === 'var') {
        return e.name === v;
      }
      let hit = false;
      mapExprChildren(e, (c) => {
        hit = hit || mentions(c);
        return c;
      });
      return hit;
    };
    return other ? mentions(other) : false;
  }
  /** cond compares E against a pure operand → same comparison reading the named var. */
  function rewriteCond(cond: Expr, E: Expr, name: string): Expr | null {
    if (cond.k !== 'bin' || !(cond.op in FLIP)) {
      return null;
    }
    if (exprEq(cond.l, E) && isPure(cond.r)) {
      return { k: 'bin', op: cond.op, l: { k: 'var', name }, r: cond.r };
    }
    if (exprEq(cond.r, E) && isPure(cond.l)) {
      return { k: 'bin', op: cond.op, l: cond.l, r: { k: 'var', name } };
    }
    return null;
  }
  function flipCmp(cond: Expr): Expr | null {
    if (cond.k !== 'bin') {
      return null;
    }
    const op = FLIP[cond.op];
    return op ? { k: 'bin', op: op as Extract<Expr, { k: 'bin' }>['op'], l: cond.l, r: cond.r } : null;
  }
  /** in `upd`, the occurrence of subtree E replaced by var `name` (E was just assigned to it). */
  function renameSubexpr(e: Expr, E: Expr, name: string): Expr {
    if (exprEq(e, E)) {
      return { k: 'var', name };
    }
    return mapExprChildren(e, (c) => renameSubexpr(c, E, name));
  }

  // R2: stage const-expressions used as bin operands into fresh locals, at statement level.
  const r2Stmt = (s: Stmt): Stmt[] => {
    const staged: Stmt[] = [];
    const stage = (e: Expr): Expr => {
      if (e.k === 'bin') {
        const l = isConstExpr(e.l) && e.l.k !== 'const' ? materialize(e.l) : stage(e.l);
        const r = isConstExpr(e.r) && e.r.k !== 'const' ? materialize(e.r) : stage(e.r);
        return { ...e, l, r };
      }
      return mapExprChildren(e, stage);
    };
    const materialize = (e: Expr): Expr => {
      const name = freshVar(T.s(32));
      staged.push({ k: 'assign', name, value: e });
      fired++;
      return { k: 'var', name };
    };
    switch (s.k) {
      case 'return': {
        if (!s.value) {
          return [s];
        }
        const v = stage(s.value);
        return [...staged, { ...s, value: v }];
      }
      case 'assign': {
        const v = stage(s.value);
        return [...staged, { ...s, value: v }];
      }
      default:
        return [s];
    }
  };

  // pass 1: R1 (may rename downstream), then R2 statement-wise
  const afterR1 = r1List(sfn.body);
  const afterR2 = afterR1.flatMap(r2Stmt);
  if (!fired) {
    return [];
  }
  const base: SFn = { ...sfn, locals: [...locals], body: afterR2 };

  // R3 variants: the tail assign-back — a non-var return lands in a local first. WHICH local is
  // itself allocator-ambiguous (gcc 2.9 wanted R1's dead value var — live-name-count sensitive;
  // another allocator may want the fresh one), so BOTH tails are emitted as candidates rather
  // than asserting one compiler's preference; the source dedupe collapses them when identical.
  const tails: SFn[] = [];
  const last = base.body[base.body.length - 1];
  if (last?.k === 'return' && last.value && last.value.k !== 'var') {
    const mk = (name: string): SFn => ({
      ...base,
      locals: [...locals],
      body: [
        ...base.body.slice(0, -1),
        { k: 'assign', name, value: (last as Extract<Stmt, { k: 'return' }>).value! } as Stmt,
        { k: 'return', value: { k: 'var', name } } as Stmt,
      ],
    });
    if (deadValueVar) {
      tails.push(mk(deadValueVar));
    }
    tails.push(mk(freshVar(T.s(32))));
  }

  return [base, ...tails];
}
