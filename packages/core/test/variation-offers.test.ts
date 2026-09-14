// When a variation is offered (`VariationDefinition.offeredWhen`), held to the code that decides it.
//
// A definition names the admission tables that refuse a candidate, or, where no table decides, one
// sentence and the export that does. These tests are what keep the names true: a table key is the
// export of that name in the file the definition is implemented in, a pointer names an export that
// exists and that enumeration reaches, and a function that consults a table cannot be pointed at
// with the table left out.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { STACKED_VARIATIONS, STRUCTURE_VARIATIONS } from '../src/rank-variations';
import { type CodePointer, type OfferedWhen, VARIATION_DEFINITIONS } from '../src/variation-definitions';
import { type GateTableName, VARIATION_GATE_TABLES, readerRules } from '../src/variation-gates';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const entries = Object.entries(VARIATION_DEFINITIONS);
const RANK_VARIATIONS = 'packages/core/src/rank-variations.ts';
const ENUMERATION = ['packages/core/src/rank.ts', RANK_VARIATIONS]
  .map((f) => readFileSync(join(REPO_ROOT, f), 'utf8'))
  .join('\n');
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

  test('a target behavior is one enumeration reads', () => {
    const unread = entries.flatMap(([n, { offeredWhen: o }]) =>
      o !== 'always' && o.target !== undefined && !ENUMERATION.includes(`compilerBehaviors.${o.target}`)
        ? [`${n}: ${o.target}`]
        : [],
    );
    expect(unread).toEqual([]);
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

  test('what a table judges is a noun phrase, never a sentence', () => {
    const bad = entries.flatMap(([n, { offeredWhen: o }]) =>
      o !== 'always' && 'judges' in o && (!/^each [^.]+[^.]$/.test(o.judges) || o.judges.length > 110 || 'when' in o)
        ? [`${n}: ${o.judges}`]
        : [],
    );
    expect(bad).toEqual([]);
  });
});
