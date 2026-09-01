// WHICH COMPILE FAILURE A NONCOMPILE ROW PUBLISHES.
//
// `scoreM2c` escalates: the source as emitted, then with the m2c dialect typedefs, then — on a
// synthetic row carrying a symbol map — with that map's declarations, then both. Whichever
// compiles is the measurement, so the interesting case is the one where none does: exactly one of
// up to four compiler errors reaches `errorMarkers` and the artifact.
//
// It used to be the FIRST rung's, on the rule "every retry is best-effort". That rule was written
// when the only retry ADDED TYPEDEFS the source might not need — a retry that can fail for its own
// reason, whose error would be a worse answer than the plain one. It stopped holding the moment a
// rung started adding the DECLARATIONS the row is compiled against: measured on `bfwordread` and
// `bfwordwrite`, the artifact published ``gPacked' undeclared`` for rows whose deciding rung
// declares `gPacked` and fails with `invalid operands to binary <<`. `errorMarkers` is not among
// `FIELDS.m2c` in report/diff.ts, so no artifact comparison could have caught it — which is why
// the pin is here, on the function, and toolchain-free.
import { describe, expect, test } from 'vitest';

import { scoreM2c } from '../src/eval/evaluate';

const SRC = 'void f(void) {}\n';
const DECLS = 'extern struct Packed gPacked;\n';
const OK = { score: 0, rows: 1, match: true } as unknown as ReturnType<Parameters<typeof scoreM2c>[0]>;

/** A scorer that records every attempt and fails each one with an error naming that rung. */
function recorder(succeedOn?: (src: string, decls?: string) => boolean) {
  const seen: { dialect: boolean; decls: boolean }[] = [];
  const score = (src: string, _sym: string, _obj: string, decls?: string) => {
    const rung = { dialect: src !== SRC, decls: decls !== undefined };
    seen.push(rung);
    if (succeedOn?.(src, decls)) {
      return OK;
    }
    throw new Error(`FAIL dialect=${rung.dialect} decls=${rung.decls}`);
  };
  return { score, seen };
}

describe('scoreM2c reports the failure of the most informed attempt on the source m2c emitted', () => {
  test('with no declarations, that is the plain attempt', () => {
    const { score, seen } = recorder();
    expect(() => scoreM2c(score, SRC, 'f', 'obj', undefined)).toThrow('FAIL dialect=false decls=false');
    expect(seen).toEqual([
      { dialect: false, decls: false },
      { dialect: true, decls: false },
    ]);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. The plain rung fails for a cause the declarations rung
  // does not have; publishing the plain rung's error names a missing declaration the row supplies.
  test('with declarations, it is the declarations attempt — not the plain one, not a dialect one', () => {
    const { score, seen } = recorder();
    expect(() => scoreM2c(score, SRC, 'f', 'obj', DECLS)).toThrow('FAIL dialect=false decls=true');
    expect(seen).toEqual([
      { dialect: false, decls: false },
      { dialect: true, decls: false },
      { dialect: false, decls: true },
      { dialect: true, decls: true },
    ]);
  });

  // The dialect rungs stay unreported for the reason they always were: they prepend typedefs, so a
  // failure there can be theirs rather than the source's. Here only the dialect+decls rung could
  // have produced an error, and the reported one is still the plain+decls rung's.
  test('a dialect rung never supplies the reported error', () => {
    const { score } = recorder();
    expect(() => scoreM2c(score, SRC, 'f', 'obj', DECLS)).toThrow(/dialect=false/);
  });

  test('a rung that compiles is the measurement, and nothing after it runs', () => {
    for (const [where, ok] of [
      ['dialect', (src: string, decls?: string) => src !== SRC && decls === undefined],
      ['declarations', (src: string, decls?: string) => src === SRC && decls !== undefined],
    ] as [string, (s: string, d?: string) => boolean][]) {
      const { score, seen } = recorder(ok);
      expect(scoreM2c(score, SRC, 'f', 'obj', DECLS), where).toBe(OK);
      expect(seen.length, where).toBe(where === 'dialect' ? 2 : 3);
    }
  });
});
