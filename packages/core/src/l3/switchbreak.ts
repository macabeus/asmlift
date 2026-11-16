// L3 respell variation: in a `void` function that ends in a `switch`, an arm leaves by `break;`
// rather than `return;`, and an empty `default:` is dropped.
//
// Nothing follows the switch but the end of the function (or a bare `return;`), so leaving an arm
// for the code after the switch and returning are one program, and so are an empty `default:` and
// none. Not one tree to two compilers: with the arms left by `break;`, mwcc 2.4.2 build 81
// (`synthetic:cwret_g17`, `synthetic:cwret_g125`) and IDO 7.1 (`synthetic:sw_void`) lost their
// matches and `synthetic:sw_defmid:ido7.1` gained one (full bench, 2026-11-12, as a print-only
// rewrite). So it is a candidate beside the `return;` spelling, never in its place.
//
// WHERE IT FIRES: the function returns `void` and its body's last statement is a `switch`, or a
// `switch` then a bare `return;`. Every bare `return;` inside an arm becomes a switch-scoped
// `break` — at any depth inside the arm, but never inside a loop or a nested `switch`, where a
// `break` would bind to that statement instead. Then a `default:` whose body is empty or only that
// `break` is dropped: a value no case names leaves the switch either way. Declines where no arm
// returns, even with an empty `default:` to drop: the drop alone is not the reading this offers,
// it compiles alike at every optimizing level of all six compilers (it moves bytes only at agbcc
// -O0 and gcc 2.7.2 -O0; compiled pairs over a 3-case and a 6-case switch), and the structurer
// never prints a `default:` that only leaves (l3/polish/voidtail.ts).
import { T, typeEquals } from '../ir/types';
import { type SFn, type Stmt, mapStmtLists } from './ast';

export function breakFinalSwitchReturns(sfn: SFn): SFn | null {
  if (!typeEquals(sfn.retType, T.void())) {
    return null;
  }
  const n = sfn.body.length;
  const tail = sfn.body[n - 1];
  const at = tail?.k === 'return' && tail.value === undefined ? n - 2 : n - 1;
  const sw = sfn.body[at];
  if (sw?.k !== 'switch' || at < 0) {
    return null;
  }
  let changed = false;
  const arm = (stmts: Stmt[]): Stmt[] =>
    stmts.map((s) => {
      if (s.k === 'return' && s.value === undefined) {
        changed = true;
        return { k: 'break', ofSwitch: true };
      }
      if (s.k === 'if') {
        return mapStmtLists(s, arm);
      }
      return s;
    });
  const cases = sw.cases.map((c) => ({ ...c, body: arm(c.body) }));
  let dflt = sw.default === undefined ? undefined : arm(sw.default);
  if (!changed) {
    return null; // no arm returns: dropping an empty `default:` alone is not this reading
  }
  if (dflt !== undefined && (dflt.length === 0 || (dflt.length === 1 && dflt[0].k === 'break' && dflt[0].ofSwitch))) {
    dflt = undefined;
  }
  const { default: _old, defaultAt: _at, ...rest } = sw;
  const out: Stmt = {
    ...rest,
    cases,
    ...(dflt === undefined
      ? {}
      : { default: dflt, ...(sw.defaultAt === undefined ? {} : { defaultAt: sw.defaultAt }) }),
  };
  return { ...sfn, body: [...sfn.body.slice(0, at), out, ...sfn.body.slice(at + 1)] };
}
