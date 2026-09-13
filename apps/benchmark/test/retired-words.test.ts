// Words and identifiers outside the enumeration vocabulary, counted over every tracked text file.
//
// The enumeration vocabulary is `docs/vocabulary.md`: a candidate, the fan, the winner, a variation
// (a candidate's name is the list of variations it applied), dropped, withheld. The rules below
// are the words and identifiers that must not stand in for them. Each rule's `allow` list is the reviewed
// set of lines where the same spelling means something else — an ECharts axis, a Tailwind variant,
// an external file's name — and never the enumeration sense.
//
// THE RULES MATCH WHOLE WORDS AND IDENTIFIER PARTS — `lever` alone, and `printLevers`, `LeverResult`
// and `ALL_LEVERS` too, since a whole-word match never sees a camelCase identifier. Two rules are
// written against a near-miss on purpose:
//   - `variant` retires and `variation` is the vocabulary's own word, so the rule matches `variant`
//     and `Variants` as a word or an identifier part; a stem such as `variant\w*` would flag every
//     renamed line.
//   - `label` is correct in every sense but a candidate's name (assembly labels, `goto` labels,
//     display labels, HTML and chart labels), so no rule matches the bare word: only the
//     candidate-name identifiers and phrases are listed.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../src/config';

interface Allow {
  path: RegExp;
  /** the line must also match this; absent = every line of the file */
  line?: RegExp;
  why: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  allow?: Allow[];
}

const THIS_FILE = relative(REPO_ROOT, import.meta.filename);

/** A retired word as a whole word in any case, or as one part of an identifier: `lever`, `Levers`,
 *  `LEVERS`, `printLevers`, `LeverResult`, `ALL_LEVERS`. Case-sensitive on purpose: `clever` and
 *  `invariant` hold the word in lower case after a lower-case letter, which no identifier part does. */
function retired(one: string, many: string): RegExp {
  const cap = (w: string): string => w[0].toUpperCase() + w.slice(1);
  const word = `(?:${many}|${one}|${cap(many)}|${cap(one)}|${many.toUpperCase()}|${one.toUpperCase()})`;
  const lower = `(?:${many}|${one})`;
  const part = `(?:${cap(many)}|${cap(one)})`;
  const upper = `(?:${many.toUpperCase()}|${one.toUpperCase()})`;
  return new RegExp(
    `\\b${word}\\b|(?<=[a-z0-9])${part}(?![a-z])|\\b(?:${lower}|${part})(?=[A-Z0-9])|(?<=_)${upper}\\b|\\b${upper}(?=_)`,
  );
}

const RULES: Rule[] = [
  {
    id: 'axis',
    pattern: retired('axis', 'axes'),
    allow: [
      { path: /^apps\/web\/src\/pages\/benchmark\/components\/charts\//, why: 'ECharts axes' },
      { path: /^apps\/web\/src\/pages\/benchmark\/theme\.ts$/, why: 'a chart grouping axis' },
      {
        path: /^apps\/web\/src\/pages\/benchmark\/components\/FeaturePicker\.tsx$/,
        why: "the feature vocabulary's grouping axis",
      },
      { path: /^apps\/web\/src\/shared\/components\/HoverCard\.tsx$/, line: /one axis/, why: 'a CSS overflow axis' },
      { path: /^packages\/bench-schema\/src\/features\.ts$/, why: "the feature vocabulary's two orthogonal axes" },
      { path: /^packages\/bench-schema\/README\.md$/, line: /filter groups by/, why: "the feature vocabulary's axis" },
      { path: /^\.claude\/commands\/dogfood-klonoa\.md$/, line: /\[window\]\[axis\]/, why: 'an array dimension' },
    ],
  },
  {
    id: 'lever',
    pattern: retired('lever', 'levers'),
    allow: [{ path: /./, line: /agbcc-source-shape-levers\.md/, why: "an external document's file name" }],
  },
  {
    id: 'variant',
    pattern: retired('variant', 'variants'),
    allow: [
      { path: /./, line: /RollRandomLevelVariant/, why: "a ROM function's symbol name" },
      { path: /^apps\/web\/src\/index\.css$/, line: /motion-safe:/, why: 'a Tailwind variant' },
      { path: /^packages\/core\/test\/determinism\.test\.ts$/, line: /alpha-variant/, why: 'a lambda-calculus term' },
      {
        path: /^packages\/core\/test\/thumb-pad-directives\.test\.ts$/,
        line: /a case variant/,
        why: 'a letter-case spelling of a directive',
      },
      { path: /^apps\/benchmark\/dataset\/synthetic\.ts$/, line: /main-variant type/, why: "gcc's own term" },
      {
        path: /^scripts\/(?:lbg-declarations\/generate\.py|regen-[a-z-]+-probes\.ts)$/,
        line: /\bvariants\b|VARIANTS\b/,
        why: "a study's set of hand-written source spellings",
      },
    ],
  },
  {
    id: 'candidate-name identifiers',
    pattern:
      /\b(?:candidateLabel|winnerLabel|LABEL_TOKENS|labelSlot|hasTokens?|parseToken|fanLabelHash)\b|label-tokens|\blabel (?:tokens?|slots?)\b/i,
  },
  {
    id: 'fan size',
    pattern: /\bcandidateCount\b/,
  },
  {
    id: 'published flags and reserved words',
    pattern: /--arms\b|--show best\b/,
  },
  {
    id: 'enumeration identifiers',
    pattern:
      /\b(?:STRUCTURING_AXES|StructuringAxis|probeGate|variantGate|SHAPE_PRODUCTS|SHAPE_SUBSETS|applyShapes|PRE_FAN_PRODUCTS|(?:LIVEBASE|BASEFOLD|UNFOLDED|ORDERBASE)_ADMISSIONS|BaseAdmission|SIGN_CANDS|LeverResult|composeLevers|onLeverError|onAxisGated|fanExitCode|rowKey|SPELLING_DEFAULTS|fanOut|FanResult|leverLabel|REGCOPY_LABEL|droppedPrimary|AxisCand|axisCands|axisFlagsOff|isBaseAxisPoint|bitfieldCands|ptrElemCands|declRankCands|svCands|variantCands|variantOff|symbolVariants|liftVariants|connectiveVariants|probeDefs|probeShapes|probeTreeOwned|armsFor|Armed)\b/,
  },
  {
    id: 'enumeration phrases',
    pattern:
      /\b(?:axis points?|sense points?|fan points?|base spelling|base lift|recorded spellings|shape products?|pre-fan products?|sanctioned product|product (?:mechanism|kind)|per-compiler default|respellings?)\b/i,
  },
];

/** Tracked text files: the scan skips data (JSON, compressed TUs) and anything that is not UTF-8
 *  text, and it skips itself, because its rules spell every retired word. */
function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter((f) => f !== '' && f !== THIS_FILE)
    .filter((f) => !/\.(?:json|gz|png|jpe?g|gif|ico|webp|woff2?|o|bin|wasm|elf|gba|z64|zip)$/i.test(f))
    .filter((f) => !/(?:^|\/)pnpm-lock\.yaml$/.test(f))
    .filter((f) => {
      try {
        return statSync(join(REPO_ROOT, f)).isFile();
      } catch {
        return false;
      }
    });
}

interface Survivor {
  rule: string;
  file: string;
  line: number;
  text: string;
}

/** Every line a rule matches that its allow list does not cover. */
function survivors(rules: readonly Rule[], files: readonly string[]): Survivor[] {
  const out: Survivor[] = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    if (text.includes('\0')) {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const rule of rules) {
        if (!rule.pattern.test(line)) {
          continue;
        }
        if (rule.allow?.some((a) => a.path.test(file) && (a.line === undefined || a.line.test(line)))) {
          continue;
        }
        out.push({ rule: rule.id, file, line: i + 1, text: line.trim().slice(0, 200) });
      }
    });
  }
  return out;
}

describe('the rules themselves', () => {
  const rule = (id: string) => RULES.find((r) => r.id === id)!.pattern;

  test('`variant` is retired and `variation` is not', () => {
    for (const w of ['variant', 'variants', 'Variant', 'VARIANTS', 'a lift variant.']) {
      expect(rule('variant').test(w)).toBe(true);
    }
    for (const w of ['variation', 'variations', 'Variation', 'VARIATION_TOKENS', 'invariant', 'Invariants']) {
      expect(rule('variant').test(w)).toBe(false);
    }
  });

  test('a retired word is found inside an identifier, and never inside an ordinary word', () => {
    for (const w of [
      'printLevers',
      'LeverResult',
      'ALL_LEVERS',
      'leverLabel',
      'onAxisGated',
      'xAxis',
      'MIPS_VARIANTS',
    ]) {
      expect(RULES.some((r) => r.pattern.test(w))).toBe(true);
    }
    for (const w of ['clever', 'leverage', 'taxis', 'maxes', 'invariants']) {
      expect(RULES.some((r) => r.pattern.test(w))).toBe(false);
    }
  });

  test('the bare word `label` is never flagged; the candidate-name identifiers are', () => {
    for (const w of ['label', 'labels', '.L1: label', 'goto label;', 'FeatureDef.label', '<label>']) {
      expect(RULES.some((r) => r.pattern.test(w))).toBe(false);
    }
    for (const w of ['candidateLabel', 'winnerLabel', 'LABEL_TOKENS', 'labelSlot', 'a label token', 'label slot']) {
      expect(rule('candidate-name identifiers').test(w)).toBe(true);
    }
  });

  test('every allow entry covers at least one line, so a stale entry is found and deleted', () => {
    const files = trackedTextFiles();
    const unused = RULES.flatMap((r) =>
      (r.allow ?? [])
        .filter(
          (a) =>
            !files.some(
              (f) =>
                a.path.test(f) &&
                readFileSync(join(REPO_ROOT, f), 'utf8')
                  .split('\n')
                  .some((l) => r.pattern.test(l) && (a.line === undefined || a.line.test(l))),
            ),
        )
        .map((a) => `${r.id}: ${a.path} ${a.line ?? ''} (${a.why})`),
    );
    expect(unused).toEqual([]);
  });
});

describe('retired words', () => {
  test('no tracked line spells one outside its allow list', () => {
    const found = survivors(RULES, trackedTextFiles());
    expect(found.map((s) => `${s.file}:${s.line} [${s.rule}] ${s.text}`)).toEqual([]);
  });
});
