// L3 respell variation `/case-end-goto`: a search loop's hit flag, read once after its loop where the
// code after the loop ends the switch arm the loop sits in, rewritten as the source's `goto` to that
// arm's end — the case-end goto (l3/ast.ts `caseEndGoto`, docs/asmlift-101.md §2.7):
//
//     f = 0;                                      for (j…) {
//     for (j…) {                                      if (hit) { s(j); goto case_end; }
//         if (hit) { s(j); f = 1; break; }        }
//     }                                    →      k(i);
//     if (f == 0) { k(i); }                       case_end:
//     break;                                      break;
//
// The structurer writes the flag where a two-level exit's second target lies past the code after
// the loop (structure.ts `TwoLevelExit`, `emitForeverExit`). Where that target is the end of the
// switch arm, agbcc threads the source's goto past the loop around the switch (jump.c
// `follow_jumps`), and on agbcc, KMC, gcc 2.7.2 and IDO the goto compiles to the source's bytes
// where the flag never does (`synthetic:sw_hitexit`); but inside asmlift's own candidates the flag
// can still score closer (gcc 2.7.2), so both are emitted, the differ referees, and a tie goes to
// the candidate without the goto (rank.ts `gotoCount`).
//
// SOUND OVER THE TREE ALONE. `f` is a local mentioned only by `f = 0;` right before the loop, by
// each hit's `f = c; break;` (c a nonzero constant, the `break` the loop's own: reached from the
// loop's body through `if`s only) and by the test right after the loop (`CASE_END_GOTO_GATES`
// `flag-elsewhere`). So after the loop `f == 0` exactly when it left by any other way than a hit,
// and `X` runs exactly then — which is what `goto L;` at each hit and `X` unguarded after the loop
// run. After `X` both spellings go on to whatever follows the `if`, and that is the arm's end with
// nothing run on the way (`target-not-arm-end`): a switch `break;` right after the `if`, which takes
// the label, or the `if` last in a list whose falling off runs nothing before leaving the switch,
// which gets a labelled `break;` appended. `L: break;` leaves the switch as falling off the arm
// does. The label sits in the loop's own list, no loop between it and its arm, and
// the hits' `break`s are reached through `if`s only, so no switch stands between them and it: the
// form `caseGotoViolation` holds every case-end goto to.
//
// A RESPELL, NOT A STRUCTURE VARIATION — the third fork of docs/level-tower.md. The rewrite reads
// nothing but the flag's tree, so asked of the structured tree it reaches every site a structure
// option inside `emitForeverExit` would, and it pays only where it fires: a structure variation
// doubles the settings every enumeration walks, which on kleod:sub_0803F68C alone outran the shard
// heap with no structuring firing. What a respell gives up is composition with the other
// pre-respell variation (`/unmerge` runs on the structured tree beside it, not on its output); no
// row has asked for both.
//
// Outer sites first, and an inner site whose `if` the outer rewrite leaves right before the outer
// label takes that label, so two search loops in sequence into one case end share one `L:`.
import { type Expr, type Loop, type SFn, type Stmt, type SwitchCase, isLoop, mapStmtLists, stmtChildren } from './ast';
import { type Gate, firstRejection } from './gates';
import { localMentions, readsOf } from './mentions';

/** A flag read after its loop that the rewrite would replace (`CASE_END_GOTO_GATES`). */
export interface CaseEndSite {
  /** what runs after the `if (f == 0)` is not the arm's end: no switch `break;` follows it, and it
   *  is not last in a list whose falling off leaves the switch with nothing run. Outside a switch
   *  arm, or in a loop inside one, neither can hold (a switch `break;` sits only in an arm with no
   *  loop between, `refuseMisboundBreak`), so this is also the rule that keeps such a flag */
  readonly targetNotArmEnd: boolean;
  /** `f` is a param or global, or mentioned anywhere but its `f = 0;`, its hits and its one test */
  readonly flagElsewhere: boolean;
}

/** When a flag read after its loop is rewritten as a case-end goto. The argument is the file's. */
export const CASE_END_GOTO_GATES: readonly Gate<CaseEndSite>[] = [
  {
    id: 'target-not-arm-end',
    why: 'the goto skips only the guarded code, so what follows it must leave the switch with nothing run',
    sound: true,
    guardedBy: [
      'case-end-goto.test.ts: a hit whose target is a join running code keeps its flag',
      'case-end-goto.test.ts: a flag read outside a switch arm, or in a loop inside one, keeps its flag',
    ],
    rejects: (c) => c.targetNotArmEnd,
  },
  {
    id: 'flag-elsewhere',
    why: 'the flag is zero after the loop exactly when no hit ran only if nothing else writes or reads it',
    sound: true,
    guardedBy: 'case-end-goto.test.ts: a flag read or written anywhere else keeps its flag',
    rejects: (c) => c.flagElsewhere,
  },
];

/** `f == 0`, the structurer's test of a flag (structure.ts `emitForeverExit`) */
const flagTest = (e: Expr): string | null =>
  e.k === 'bin' && e.op === '==' && e.l.k === 'var' && e.r.k === 'const' && e.r.value === 0 ? e.l.name : null;

/** The hits in `body`, a loop's body: each `f = c; break;` (c a nonzero constant) reached through
 *  `if`s only, so the `break` is that loop's own. */
function hitsIn(body: readonly Stmt[], flag: string): number {
  return body.reduce((n, s, i) => {
    const next = body[i + 1];
    if (
      s.k === 'assign' &&
      s.name === flag &&
      s.value.k === 'const' &&
      s.value.value !== 0 &&
      next?.k === 'break' &&
      next.ofSwitch !== true &&
      next.label === undefined
    ) {
      return n + 1;
    }
    return s.k === 'if' ? n + hitsIn(s.then, flag) + hitsIn(s.else, flag) : n;
  }, 0);
}

/** `body` with each hit `hitsIn` counts written `goto label;` */
function jumpHits(body: readonly Stmt[], flag: string, label: string): Stmt[] {
  return body.flatMap((s, i): Stmt[] => {
    const prev = body[i - 1];
    if (s.k === 'break' && prev?.k === 'assign' && prev.name === flag && s.ofSwitch !== true) {
      return [];
    }
    if (s.k === 'assign' && s.name === flag) {
      return [{ k: 'caseEndGoto', label }];
    }
    return s.k === 'if' ? [{ ...s, then: jumpHits(s.then, flag, label), else: jumpHits(s.else, flag, label) }] : [s];
  });
}

/** `f = 0; LOOP; if (f == 0) { X }` starting at `list[i]`, the structurer's flag read after its loop */
function siteAt(
  list: readonly Stmt[],
  i: number,
): { flag: string; loop: Loop; test: Extract<Stmt, { k: 'if' }> } | null {
  const [init, loop, test] = [list[i], list[i + 1], list[i + 2]];
  if (
    init?.k !== 'assign' ||
    init.value.k !== 'const' ||
    init.value.value !== 0 ||
    loop === undefined ||
    !isLoop(loop) ||
    test?.k !== 'if' ||
    test.else.length > 0 ||
    flagTest(test.cond) !== init.name
  ) {
    return null;
  }
  return { flag: init.name, loop, test };
}

/** Every flag read after its loop where the code after the loop ends its switch arm, rewritten as
 *  a case-end goto, or null where none is (the variation's decline). */
export function jumpToCaseEnds(sfn: SFn, gates: readonly Gate<CaseEndSite>[] = CASE_END_GOTO_GATES): SFn | null {
  const mentions = localMentions(sfn);
  const labels = new Set<string>();
  const collect = (s: Stmt): void => {
    if (s.k === 'switch') {
      s.cases.forEach((c) => c.label !== undefined && labels.add(c.label));
    } else if (s.k === 'break' && s.label !== undefined) {
      labels.add(s.label);
    }
    stmtChildren(s).forEach(collect);
  };
  sfn.body.forEach(collect);
  const fresh = (): string => {
    let label = 'case_end';
    for (let n = 2; labels.has(label); n++) {
      label = `case_end_${n}`;
    }
    labels.add(label);
    return label;
  };
  const dropped = new Set<string>();

  /** `inArm`: the list is inside a switch arm with no loop between; `leaves`: falling off its end
   *  leaves that switch with nothing run on the way. */
  const rewrite = (list: readonly Stmt[], inArm: boolean, leaves: boolean): Stmt[] => {
    const out = [...list];
    for (let i = 0; i < out.length; i++) {
      const site = siteAt(out, i);
      if (site !== null) {
        const { flag, loop, test } = site;
        const after = out[i + 3];
        const end = after?.k === 'break' && after.ofSwitch === true ? after : undefined;
        const m = mentions.get(flag);
        const hits = hitsIn(loop.body, flag);
        const refused = firstRejection(gates, {
          targetNotArmEnd: end === undefined && !(after === undefined && leaves),
          flagElsewhere:
            m === undefined || hits === 0 || m.assigns !== hits + 1 || readsOf(m) !== 1 || m.addrTaken !== 0,
        });
        if (refused === null) {
          const label = end?.label ?? fresh();
          const jumped: Stmt = { ...loop, body: jumpHits(loop.body, flag, label) };
          out.splice(i, end ? 4 : 3, descend(jumped, false, undefined, false), ...test.then, {
            k: 'break',
            ofSwitch: true,
            label,
          });
          dropped.add(flag);
          // `X` is visited next, in this list, so a site inside it whose `if` now sits right before
          // the label takes that label
          continue;
        }
      }
      out[i] = descend(out[i], inArm, out[i + 1], i === out.length - 1 && leaves);
    }
    return out;
  };
  /** `s` with its lists rewritten; `next` follows it in its list, and `last` says it ends a list
   *  whose falling off leaves the switch */
  const descend = (s: Stmt, inArm: boolean, next: Stmt | undefined, last: boolean): Stmt => {
    if (s.k === 'switch') {
      const arm = (c: SwitchCase): SwitchCase => ({ ...c, body: rewrite(c.body, true, !c.fallsThrough) });
      return { ...s, cases: s.cases.map(arm), ...(s.default ? { default: rewrite(s.default, true, true) } : {}) };
    }
    if (isLoop(s)) {
      return mapStmtLists(s, (l) => rewrite(l, false, false));
    }
    if (s.k === 'if') {
      const leaves = inArm && ((next?.k === 'break' && next.ofSwitch === true) || (next === undefined && last));
      return { ...s, then: rewrite(s.then, inArm, leaves), else: rewrite(s.else, inArm, leaves) };
    }
    return s;
  };
  const body = rewrite(sfn.body, false, false);
  if (dropped.size === 0) {
    return null;
  }
  return { ...sfn, body, locals: sfn.locals.filter((l) => !dropped.has(l.name)) };
}
