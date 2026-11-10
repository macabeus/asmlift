// THE ONE HARVESTER of the decline messages `packages/core/src` can throw, and the census built from
// it. `apps/web/test/declines.test.ts` and `scripts/regen-decline-census.ts` both import this, so
// the census the script writes and the census the test recomputes cannot come from two walks.
//
// The census is committed as `apps/web/src/pages/benchmark/lib/declines-census.json`. The figures
// `declines.ts` used to spell in prose — the distinct-message count, the residue total, the
// per-file residue — live there instead, with the residual messages themselves, and the test fails
// with the regenerate command when the file and the recomputation differ. It reads core's sources
// and `declines.ts`'s classes and NOTHING ELSE — not the benchmark artifact, which every round
// regenerates — so it moves only when a decline message or a class does. Regenerate it with
//
//   pnpm regen:declines-census
//
// after a reworded, new, moved or removed throw in core, or a class added, changed or reordered.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DECLINE_CLASSES, OTHER_CLASS } from '../src/pages/benchmark/lib/declines';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
const CORE_SRC = join(ROOT, 'packages/core/src');

/** The committed census, relative to the repo root. */
export const CENSUS_PATH = 'apps/web/src/pages/benchmark/lib/declines-census.json';
/** The command that rewrites `CENSUS_PATH`; a failing comparison names it. */
export const REGEN_COMMAND = 'pnpm regen:declines-census';

/** Every decline message `packages/core/src` can throw, as a template.
 *
 *  A DECLINE is what the benchmark publishes as a marker: the pipeline catches these constructors
 *  and annotates. Each site's balanced-paren argument is taken, its string-literal pieces kept and
 *  every `${…}` replaced by a placeholder — so an interpolated MNEMONIC or SYMBOL becomes `X` here,
 *  which is why a class keyed on a mnemonic alternation cannot be exercised from this corpus and is
 *  pinned by hand instead (see `NOT_IN_TEMPLATES` in the test). */
export const DECLINE_CTORS = new Set([
  'FrontendUnsupportedError',
  'PpcUnsupportedError',
  'RaiseUnsupportedError',
  // A SUBCLASS IS A FIFTH CTOR TO THIS HARVEST, not a fourth: the walk reads the NAME at the throw
  // site and knows nothing about the class hierarchy. `StructOverlapError extends
  // RaiseUnsupportedError`, and leaving it out took raise/structs.ts's two overlap messages out of
  // the harvest — which made the `structs` class match nothing core can throw.
  'StructOverlapError',
  'StructureError',
]);

/** The type a frontend hands its refusal to shared code as (frontend/errors.ts). */
const SHARED_REFUSAL = /\bFrontendRefusal\b/;

export interface CoreSource {
  file: string;
  src: string;
}

export interface DeclineTemplate {
  file: string;
  line: number;
  text: string;
}

export const coreSources = (): CoreSource[] => {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith('.ts')) {
        files.push(p);
      }
    }
  })(CORE_SRC);
  return files.sort().map((f) => ({ file: f.slice(CORE_SRC.length + 1), src: readFileSync(f, 'utf8') }));
};

export const declineTemplates = (sources: readonly CoreSource[]): DeclineTemplate[] => {
  const out: DeclineTemplate[] = [];
  for (const { file, src } of sources) {
    // A FILE THAT HOLDS A `FrontendRefusal` throws through it, so each call of one there, `fail(`
    // or a dialect's `d.fail(`, is a site too.
    const re = SHARED_REFUSAL.test(src) ? /throw new (\w+)\(|(?<!\w)(?:\w+\.)?(fail)\(/g : /throw new (\w+)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (m[2] === undefined && !DECLINE_CTORS.has(m[1])) {
        continue;
      }
      let i = m.index + m[0].length;
      let depth = 1;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') {
          depth++;
        } else if (src[i] === ')') {
          depth--;
        }
        i++;
      }
      const arg = src.slice(start, i - 1);
      const pieces: string[] = [];
      const lit = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
      let l: RegExpExecArray | null;
      while ((l = lit.exec(arg))) {
        pieces.push(l[1] ?? l[2] ?? l[3] ?? '');
      }
      const text = pieces
        .join('')
        .replace(/\$\{[^}]*\}/g, 'X')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        out.push({ file, line: src.slice(0, m.index).split('\n').length, text });
      }
    }
  }
  return out;
};

/** The class a harvested template falls in — first match, as `declineClassesOf` decides a marker. */
export const classOfText = (t: string): string =>
  DECLINE_CLASSES.find((c) => c.pattern.test(t))?.key ?? OTHER_CLASS.key;

export interface DeclineCensus {
  /** What `REGEN_COMMAND` rewrites, said inside the file so a reader of the JSON finds it. */
  generatedBy: string;
  distinctMessages: number;
  /** Distinct messages no class claims: they fall in "other". */
  residueTotal: number;
  /** Per file (the file of a message's FIRST harvested site), count descending then file. */
  residueByFile: { file: string; count: number; messages: string[] }[];
}

export const buildCensus = (templates: readonly DeclineTemplate[]): DeclineCensus => {
  const distinct = [...new Set(templates.map((t) => t.text))];
  const unclassified = distinct.filter((t) => classOfText(t) === OTHER_CLASS.key);
  const byFile = new Map<string, string[]>();
  for (const t of unclassified) {
    const file = templates.find((x) => x.text === t)!.file;
    byFile.set(file, [...(byFile.get(file) ?? []), t]);
  }
  const residueByFile = [...byFile.entries()]
    .map(([file, messages]) => ({ file, count: messages.length, messages: messages.sort() }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return {
    generatedBy: `${REGEN_COMMAND} (scripts/regen-decline-census.ts) — do not hand-edit`,
    distinctMessages: distinct.length,
    residueTotal: unclassified.length,
    residueByFile,
  };
};

/** The census of core's sources as they stand. */
export const currentCensus = (): DeclineCensus => buildCensus(declineTemplates(coreSources()));
