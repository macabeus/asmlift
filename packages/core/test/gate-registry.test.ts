// `src/gate-registry.ts` is the one list of gate tables that the contract test
// (gate-contract.test.ts) and the benchmark's refusal census (apps/benchmark run/gate-census.ts)
// both iterate. It fails in one way: a table OMITTED from it ships with no contract and no census
// seat, and no assertion over the list can see a table that is not on it. So this file reads the
// declarations out of `src/` and compares them with the list.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { GATE_TABLES, GATE_TABLE_BUNDLES } from '../src/gate-registry';

const SRC = join(__dirname, '..', 'src');

const srcFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (p.endsWith('.ts')) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
};

/** Every exported const that is a gate table by NAME (`*_GATES`, whatever its type) or by TYPE
 *  (annotated `Gate<…>[]`, whatever its name — `SCOPEBASE_ELIGIBILITY`), with the module that
 *  declares it. */
const declared = (): { name: string; module: string }[] =>
  srcFiles().flatMap((f) => {
    const module = f
      .slice(SRC.length + 1)
      .replace(/\.ts$/, '')
      .replaceAll('\\', '/');
    const text = readFileSync(f, 'utf8');
    const byName = [...text.matchAll(/^export const ([A-Z][A-Z0-9_]*_GATES)\b/gm)].map((m) => m[1]);
    const byType = [...text.matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*:\s*(?:readonly\s+)?Gate</gm)].map((m) => m[1]);
    return [...new Set([...byName, ...byType])].map((name) => ({ name, module }));
  });

const registered = [
  ...GATE_TABLES.filter((t) => !t.composed).map((t) => ({ name: t.name, module: t.module })),
  ...GATE_TABLE_BUNDLES.map((b) => ({ name: b.name, module: b.module })),
];
const key = (d: { name: string; module: string }): string => `${d.module}:${d.name}`;

describe('the gate registry', () => {
  test('lists every gate table the source exports, under the module that exports it', () => {
    const found = declared();
    // REACH: a regex that stops matching would make the check below pass by finding nothing.
    expect(found.length, 'the declaration scan found no gate tables at all — its regex has rotted').toBeGreaterThan(20);
    const have = new Set(registered.map(key));
    const missing = found
      .map(key)
      .filter((k) => !have.has(k))
      .sort();
    expect(missing, `exported gate tables absent from src/gate-registry.ts: ${missing.join(', ')}`).toEqual([]);
  });

  test('lists nothing the source does not export', () => {
    const exported = new Set(declared().map(key));
    expect(registered.map(key).filter((k) => !exported.has(k))).toEqual([]);
  });

  test('each entry holds the very object its module exports under that name', async () => {
    const wrong: string[] = [];
    for (const t of GATE_TABLES) {
      const mod = (await import(join(SRC, `${t.module}.ts`))) as Record<string, unknown>;
      if (t.composed) {
        // Built at runtime, so no export holds it; that the module loads is what can be checked.
        continue;
      }
      if (mod[t.name] !== t.table) {
        wrong.push(`${t.name} is not ${t.module}'s export of that name`);
      }
    }
    for (const b of GATE_TABLE_BUNDLES) {
      const mod = (await import(join(SRC, `${b.module}.ts`))) as Record<string, unknown>;
      if (mod[b.name] !== b.bundle) {
        wrong.push(`${b.name} is not ${b.module}'s export of that name`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('a bundle holds tables the registry lists, so the contract reaches it through its parts', () => {
    const byName = new Map(GATE_TABLES.map((t) => [t.name, t.table]));
    const wrong: string[] = [];
    for (const b of GATE_TABLE_BUNDLES) {
      expect(Object.keys(b.bundle).sort(), b.name).toEqual(Object.keys(b.parts).sort());
      for (const [k, name] of Object.entries(b.parts)) {
        if (byName.get(name) !== b.bundle[k]) {
          wrong.push(`${b.name}.${k} is not the registry's ${name}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('names are unique, and so is each census seat', () => {
    const names = GATE_TABLES.map((t) => t.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const seats = GATE_TABLES.flatMap((t) => (t.census ? [`${t.census.pass}/${t.census.table}`] : []));
    expect(seats.filter((s, i) => seats.indexOf(s) !== i)).toEqual([]);
  });
});
