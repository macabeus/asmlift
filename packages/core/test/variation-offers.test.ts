// When a variation is offered (`VariationDefinition.offeredWhen`), held to the code that decides it.
//
// A definition names the admission tables that refuse a candidate, or, where no table decides, one
// sentence and the export that does. What these tests prove, and no more: a table key is the export
// of that name in the file the definition is implemented in, and a hoist's table is the one its
// variation's roster entry runs; a pointer names an export that exists and that enumeration's code
// (comments aside) names; a function that consults a table cannot be pointed at with the table left
// out; enumeration reads a compiler behavior only through a registry entry's target gate. They do not
// prove that the pointed export is the whole decision.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import {
  BASEFOLD_HOISTS,
  LIVEBASE_HOISTS,
  ORDERBASE_HOISTS,
  STACKED_VARIATIONS,
  STRUCTURE_VARIATIONS,
  UNFOLDED_HOISTS,
} from '../src/rank-variations';
import { type CodePointer, type OfferedWhen, VARIATION_DEFINITIONS } from '../src/variation-definitions';
import { type GateTableName, VARIATION_GATE_TABLES, readerRules } from '../src/variation-gates';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const entries = Object.entries(VARIATION_DEFINITIONS);
const RANK_VARIATIONS = 'packages/core/src/rank-variations.ts';
const withoutComments = (file: string): string =>
  ts
    .createPrinter({ removeComments: true })
    .printFile(ts.createSourceFile(file, readFileSync(join(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest));
/** Enumeration's code with its comments removed: a name only a comment mentions is not reached. */
const ENUMERATION = ['packages/core/src/rank.ts', RANK_VARIATIONS].map(withoutComments).join('\n');
const HOISTS = [...LIVEBASE_HOISTS, ...BASEFOLD_HOISTS, ...UNFOLDED_HOISTS, ...ORDERBASE_HOISTS];
const tableName = (table: unknown): GateTableName | undefined =>
  (Object.keys(VARIATION_GATE_TABLES) as GateTableName[]).find((k) => VARIATION_GATE_TABLES[k] === table);
/** An exported admission table's name, as `gate-contract.test.ts` registers them. */
const TABLE_NAME = /\b[A-Z][A-Z0-9_]*(?:_GATES|_ELIGIBILITY)\b/g;

const load = (file: string) => import(join(REPO_ROOT, file)) as Promise<Record<string, unknown>>;
const gatesOf = (o: OfferedWhen): readonly GateTableName[] => (o === 'always' ? [] : (o.gates ?? []));
const pointerOf = (o: OfferedWhen): CodePointer | undefined =>
  o !== 'always' && 'decidedBy' in o ? o.decidedBy : undefined;

describe('every gate reference resolves', () => {
  test("a table is the export of that name in the file the definition's `implementedIn` names", async () => {
    const bad: string[] = [];
    for (const [n, d] of entries) {
      const mod = await load(d.implementedIn);
      for (const g of gatesOf(d.offeredWhen)) {
        if (mod[g] !== VARIATION_GATE_TABLES[g]) {
          bad.push(`${n}: ${g} is not exported by ${d.implementedIn}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('every table the registry holds is named by a definition, and each has rules', () => {
    const named = new Set(entries.flatMap(([, d]) => gatesOf(d.offeredWhen)));
    expect(Object.keys(VARIATION_GATE_TABLES).filter((t) => !named.has(t as GateTableName))).toEqual([]);
    expect(
      entries.filter(([, d]) => gatesOf(d.offeredWhen).length > 0 && readerRules(gatesOf(d.offeredWhen)).length === 0),
    ).toEqual([]);
  });

  test('a pointer names an export of a file that exists', async () => {
    const bad: string[] = [];
    for (const [n, d] of entries) {
      const p = pointerOf(d.offeredWhen);
      if (p === undefined) {
        continue;
      }
      if (!existsSync(join(REPO_ROOT, p.file)) || !((p.symbol in (await load(p.file))) as boolean)) {
        bad.push(`${n}: ${p.symbol} in ${p.file}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('a pointer outside enumeration names something enumeration calls', () => {
    const uncalled = entries.flatMap(([n, d]) => {
      const p = pointerOf(d.offeredWhen);
      return p !== undefined && !new RegExp(`\\b${p.symbol}\\b`).test(ENUMERATION) ? [`${n}: ${p.symbol}`] : [];
    });
    expect(uncalled).toEqual([]);
  });

  // A direct `compilerBehaviors` read would be a gate the registry does not hold, so the drawer's
  // target line would stop being what enumeration does. The one read allowed is the span `nearbase`
  // computes with, which its entry gates as well.
  test('enumeration reads no compiler behavior directly but the span it computes with', () => {
    expect([...new Set(ENUMERATION.match(/\bcompilerBehaviors\.\w+/g))]).toEqual(['compilerBehaviors.nearBaseSpan']);
  });

  test("a hoist's table is among its variation's tables, and a hoist table is named only by its variation", () => {
    const bad = HOISTS.flatMap((h) => {
      const t = tableName(h.gates);
      return t !== undefined && gatesOf(VARIATION_DEFINITIONS[h.variations[0]].offeredWhen).includes(t)
        ? []
        : [`${h.variations.join('/')} runs ${t ?? 'an unregistered table'}`];
    });
    const hoistTables = new Set(HOISTS.map((h) => tableName(h.gates)));
    for (const [n, d] of entries) {
      for (const g of gatesOf(d.offeredWhen)) {
        if (hoistTables.has(g) && !HOISTS.some((h) => h.variations[0] === n && h.gates === VARIATION_GATE_TABLES[g])) {
          bad.push(`${n} names ${g}, which no hoist of its own runs`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('an export that consults a table cannot be pointed at with that table left out', async () => {
    const bad: string[] = [];
    for (const [n, d] of entries) {
      const p = pointerOf(d.offeredWhen);
      const f = p === undefined ? undefined : (await load(p.file))[p.symbol];
      if (typeof f !== 'function') {
        continue;
      }
      const named = new Set<string>(gatesOf(d.offeredWhen));
      for (const t of f.toString().match(TABLE_NAME) ?? []) {
        if (!named.has(t)) {
          bad.push(`${n}: ${p!.symbol} consults ${t}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // The structure and stacked variations are table entries whose gate or pass is a value, so the
  // pointer is checked against the entry itself rather than against a name in a source file.
  test("a structure variation points at its entry's gate, or at the table where that gate is written inline", async () => {
    const bad: string[] = [];
    for (const v of STRUCTURE_VARIATIONS) {
      const gate = v.sharedGate ?? v.perLiftGate;
      const p = pointerOf(VARIATION_DEFINITIONS[v.name].offeredWhen);
      if (gate === undefined || p === undefined) {
        bad.push(`${v.name}: ${gate === undefined ? 'no gate' : 'no pointer'}`);
        continue;
      }
      const inline = p.symbol === 'STRUCTURE_VARIATIONS' && p.file === RANK_VARIATIONS;
      const f = inline ? undefined : (await load(p.file))[p.symbol];
      // A word, not `name(`: the test transform spells an imported call `(0, __vi_import_0__.name)(`.
      if (!inline && f !== gate && !new RegExp(`\\b${p.symbol}\\b`).test(gate.toString())) {
        bad.push(`${v.name}: its gate neither is nor calls ${p.symbol}`);
      }
    }
    expect(bad).toEqual([]);
    const structural = new Set<string>(STRUCTURE_VARIATIONS.map((v) => v.name));
    expect(
      entries.filter(([n, d]) => pointerOf(d.offeredWhen)?.symbol === 'STRUCTURE_VARIATIONS' && !structural.has(n)),
    ).toEqual([]);
  });

  test("a stacked variation points at its entry's pass", async () => {
    const bad: string[] = [];
    for (const v of STACKED_VARIATIONS) {
      const p = pointerOf(VARIATION_DEFINITIONS[v.name].offeredWhen);
      if (p === undefined || (await load(p.file))[p.symbol] !== v.apply) {
        bad.push(v.name);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('no definition keeps free-text gate logic', () => {
  test('a condition no table decides is one short sentence', () => {
    const bad = entries.flatMap(([n, { offeredWhen: o }]) =>
      o !== 'always' && 'when' in o && (!/^[^.]+\.$/.test(o.when) || o.when.length > 130) ? [`${n}: ${o.when}`] : [],
    );
    expect(bad).toEqual([]);
  });

  test('no two variations judge the same thing', () => {
    const judged = entries.flatMap(([, { offeredWhen: o }]) => (o !== 'always' && 'judges' in o ? [o.judges] : []));
    expect(judged.filter((j, i) => judged.indexOf(j) !== i)).toEqual([]);
  });

  test('what a table judges is a noun phrase, never a sentence', () => {
    const bad = entries.flatMap(([n, { offeredWhen: o }]) =>
      o !== 'always' && 'judges' in o && (!/^each [^.]+[^.]$/.test(o.judges) || o.judges.length > 110 || 'when' in o)
        ? [`${n}: ${o.judges}`]
        : [],
    );
    expect(bad).toEqual([]);
  });
});

// The drawer lists every rule of a registered table verbatim, so each `why` there is reader copy.
describe('a rule a reader sees reads as prose', () => {
  const DEFECTS: readonly [string, (why: string) => boolean][] = [
    ['an unclosed code span', (w) => w.split('`').length % 2 === 0],
    ['a leading code span, which the drawer would capitalize', (w) => w.startsWith('`')],
    ['a shouted word', (w) => /\b[A-Z]{3,}\b/.test(w)],
    ['a file name', (w) => /\.ts\b/.test(w)],
    ['a function call', (w) => /\w\(\)/.test(w)],
    ['a variation spelled with a slash', (w) => /(^|\s)\/[a-z]/.test(w)],
    ['an opening pronoun, which names nothing out of its table', (w) => /^(?:it|that|this|there|they)\b/.test(w)],
    [
      'a word only the pass’s own code gives a meaning',
      (w) => /\b(?:rung|ladder|re-materiali[sz]es|home|key|tree’s)\b/.test(w),
    ],
  ];

  test('no rule carries a defect a reader would trip on', () => {
    const rules = readerRules(Object.keys(VARIATION_GATE_TABLES) as GateTableName[]);
    const bad = rules.flatMap(({ id, why }) => DEFECTS.filter(([, has]) => has(why)).map(([what]) => `${id}: ${what}`));
    expect(bad).toEqual([]);
    expect(rules.length).toBeGreaterThan(100);
  });

  // A drawer lists a reason once, with the first table's badge, so one reason is never both.
  test('one reason is never both required and a heuristic', () => {
    const soundness = new Map<string, Set<boolean>>();
    for (const table of Object.values(VARIATION_GATE_TABLES)) {
      for (const { why, sound } of table) {
        soundness.set(why, (soundness.get(why) ?? new Set()).add(sound));
      }
    }
    expect([...soundness].filter(([, s]) => s.size > 1).map(([why]) => why)).toEqual([]);
  });
});

// WHICH VARIATIONS THE DEFAULT-ACCEPTS GUARD COVERS, derived from the guard rather than restated.
//
// `structure()` holds one invariant about the whole registry: a candidate spelling never unlocks a
// function the default declines. It is enforced two ways, not one — `assertDefaultAccepts` re-runs
// the default structuring for the options it RESETS, and each variation it does not reset carries a
// written argument instead. That split is an authoring decision about every new variation, so the
// set of non-members is a fact a reader acts on, and a prose set drifts: the same split was stated
// in two files and the two disagreed about its size while every gate was green.
//
// So it is stated in ONE comment, beside the guard, and this derives the other side of it from the
// guard's own reset list. Add a variation and forget the guard and this goes red naming it.
describe("the assertDefaultAccepts guard's members are derived, not described", () => {
  const STRUCTURE = 'packages/core/src/structure/structure.ts';
  /** The options `assertDefaultAccepts` turns off before re-running the default structuring. Read
   *  from its body with comments stripped, so a name only a comment mentions is not counted. */
  const resetByGuard = (): Set<string> => {
    const body = /function assertDefaultAccepts\b[\s\S]*?\n}/.exec(withoutComments(STRUCTURE));
    expect(body, 'assertDefaultAccepts must still be a top-level function in structure.ts').not.toBeNull();
    return new Set([...body![0].matchAll(/(\w+): false/g)].map((m) => m[1]));
  };
  /** The single `StructureOptions` key a variation writes. */
  const optionKey = (v: (typeof STRUCTURE_VARIATIONS)[number]): string => {
    const keys = Object.keys(v.options(true) ?? {});
    expect(keys, `/${v.name} must write exactly one structure option`).toHaveLength(1);
    return keys[0];
  };
  /** The `/name`s structure.ts's comment lists as deliberate non-members: the bullets that follow
   *  its anchor line, stopping at the first line that is not one. */
  const namedNonMembers = (): string[] => {
    const src = readFileSync(join(REPO_ROOT, STRUCTURE), 'utf8').split('\n');
    const at = src.findIndex((l) => l.includes('DOES NOT RESET'));
    expect(at, 'structure.ts must still anchor the list with "DOES NOT RESET"').toBeGreaterThan(-1);
    const out: string[] = [];
    for (let i = at + 1; i < src.length; i++) {
      const m = /^\s*\/\/\s+- `(\/[a-z-]+)`/.exec(src[i]);
      if (m) {
        out.push(m[1]);
      } else if (!/^\s*\/\//.test(src[i])) {
        break;
      }
    }
    return out.sort();
  };

  test('the probe finds the guard and the list, so neither gate below can pass vacuously', () => {
    expect(resetByGuard().size).toBeGreaterThan(5);
    expect(namedNonMembers().length).toBeGreaterThan(0);
  });

  test('every structure variation the guard does not reset is one the comment names', () => {
    const notReset = STRUCTURE_VARIATIONS.filter((v) => !resetByGuard().has(optionKey(v)))
      .map((v) => `/${v.name}`)
      .sort();
    expect(notReset).toEqual(namedNonMembers());
  });

  test('…and every name the comment lists is a registered structure variation', () => {
    const registered = new Set(STRUCTURE_VARIATIONS.map((v) => `/${v.name}`));
    expect(namedNonMembers().filter((n) => !registered.has(n))).toEqual([]);
  });
});
