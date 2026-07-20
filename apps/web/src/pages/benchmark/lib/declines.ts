// Decline-reason classification over asmlift's DECLINED rows — the "blocker Pareto". Every declined
// row carries structured markers (`<stage>: <reason>`, from asmlift's annotate-mode diagnostics);
// classifying them by capability gap answers the roadmap question the raw outcome counts can't:
// WHICH missing capability blocks the most functions.
//
// The classes are regex-matched against asmlift's decline-message vocabulary. That vocabulary is
// deliberately stable prose (each decline message names its construct); an unrecognized reason
// falls into "other" with its raw text preserved — never silently dropped.
import type { FunctionResult } from '@asmlift/bench-schema';

export interface DeclineClass {
  key: string;
  label: string;
  pattern: RegExp;
}

export const DECLINE_CLASSES: DeclineClass[] = [
  {
    key: 'stack-frames',
    label: 'Local stack frames (address-taken locals / spills)',
    pattern:
      /stack pointer .* used as data|local stack frames not supported|spill of a live value|reload of a stack local|sub-word stack-frame|stack-passed|never stored/,
  },
  {
    key: 'cross-block-cr',
    label: 'Cross-block condition flags (PPC cr)',
    pattern: /no reaching compare/,
  },
  {
    key: 'branch-likely',
    label: 'Branch-likely / coprocessor branches (MIPS)',
    pattern: /branch-likely|coprocessor branch/,
  },
  {
    key: 'mips-calls',
    label: 'MIPS calls (jal/jalr)',
    pattern: /MIPS calls not yet modelled/,
  },
  {
    key: 'pic-globals',
    label: 'PIC / gp-relative / SDA globals',
    pattern: /gp used as data|PIC|small-data|SDA|global-relative/,
  },
  {
    key: 'store-class',
    label: 'Unmodelled store-class instructions',
    pattern: /unmodelled store-class/,
  },
  {
    key: 'loop-shapes',
    label: 'Loop shapes declined (multi-latch / irreducible / hazards)',
    pattern: /unrecovered back-edge|loop-recovery declined|pre-update loop variable/,
  },
  {
    key: 'switch-shapes',
    label: 'Switch fall-through / jump-table shapes',
    pattern: /fall-through|jump-table/,
  },
  {
    key: 'structs',
    label: 'Struct layouts (packed / overlapping)',
    pattern: /cannot recover struct|naturally aligned|overlapping fields/,
  },
  {
    key: 'float',
    label: 'Floating point',
    pattern:
      /unmodelled instruction '(mfc1|mtc1|ctc1|cfc1|lwc1|ldc1|swc1|sdc1|cvt[.\w]*|add\.|sub\.|mul\.|div\.|mov\.|neg\.|abs\.|c\.|trunc[.\w]*|fadd|fsub|fmul|fdiv|fmr|fcmp\w*|frsp|fct\w*|lfs|lfd|stfs|stfd)'/,
  },
  {
    key: 'opaque-ops',
    label: 'Other unmodelled instructions (opaque)',
    pattern: /unmodelled instruction|no lowering for op/,
  },
  {
    key: 'control-flow',
    label: 'Other unmodelled control flow',
    pattern: /unmodelled control transfer|not a block boundary|indirect|computed/,
  },
];

export const OTHER_CLASS = { key: 'other', label: 'Other / unclassified' };

/** The decline classes exhibited by one row's asmlift markers (a row can exhibit several). */
export function declineClassesOf(r: FunctionResult): string[] {
  if (r.asmlift.outcome !== 'declined') {
    return [];
  }
  const found = new Set<string>();
  for (const m of r.asmlift.errorMarkers ?? []) {
    const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
    found.add(cls ? cls.key : OTHER_CLASS.key);
  }
  return [...found];
}

export interface ParetoRow {
  key: string;
  label: string;
  count: number; // rows blocked (a row counts once per class it exhibits)
  examples: string[]; // up to 3 raw marker strings, for the tooltip
}

/** Rows blocked per decline class, sorted descending — the Pareto. */
export function declinePareto(rows: FunctionResult[]): ParetoRow[] {
  const acc = new Map<string, ParetoRow>();
  for (const r of rows) {
    if (r.asmlift.outcome !== 'declined') {
      continue;
    }
    for (const m of r.asmlift.errorMarkers ?? []) {
      const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
      const key = cls?.key ?? OTHER_CLASS.key;
      const label = cls?.label ?? OTHER_CLASS.label;
      let row = acc.get(key);
      if (!row) {
        acc.set(key, (row = { key, label, count: 0, examples: [] }));
      }
    }
    // count each ROW once per class (not once per marker)
    for (const key of declineClassesOf(r)) {
      const row = acc.get(key)!;
      row.count++;
      const marker = (r.asmlift.errorMarkers ?? []).find((m) => {
        const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
        return (cls?.key ?? OTHER_CLASS.key) === key;
      });
      if (marker && row.examples.length < 3 && !row.examples.includes(marker)) {
        row.examples.push(marker);
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count);
}
