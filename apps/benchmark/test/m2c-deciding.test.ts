// WHICH m2c TEXT A ROW PUBLISHES, and whose compiler error. m2c's C++ target spells the implicit
// receiver `this`, a keyword in the dialect a C++ row compiles in, so a row that compiles nowhere is
// retried with that receiver renamed. The retry only REMOVES that harness artifact, so it is the more
// informed attempt: the row publishes it, with its own error. Publishing the first attempt's error
// instead names the keyword artifact as the cause on a row whose real failure is m2c's own.
import { describe, expect, test, vi } from 'vitest';

const M2C_SOURCE = 'void f__5ThingFv(Thing *this) {\n    this->unk0 = unk520;\n}\n';

vi.mock('../src/eval/m2c', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/eval/m2c')>()),
  runM2c: () => ({ failed: false, source: M2C_SOURCE }),
}));

const { evaluateM2c } = await import('../src/eval/evaluate');

const SPEC = {
  sym: 'f__5ThingFv',
  project: 'p',
  language: 'c++',
  features: [],
  refSource: '',
  loc: 1,
  codegen: { cflags: '' },
  tier: 'real',
} as unknown as Parameters<typeof evaluateM2c>[1];

const TC = {} as unknown as Parameters<typeof evaluateM2c>[0];

/** A scorer that fails each text with its own message, and matches the ones named in `scores`. */
const scorer = (errors: Record<string, string>, scores: string[] = []) =>
  ((src: string) => {
    if (scores.some((s) => src.includes(s))) {
      return { score: 0, rows: 4, match: true };
    }
    const key = Object.keys(errors).find((k) => src.includes(k));
    throw new Error(key === undefined ? '# unexpected text' : errors[key]);
  }) as unknown as Parameters<typeof evaluateM2c>[4];

describe('the row publishes the m2c text that decided it', () => {
  test('nothing compiles: the RENAMED attempt’s text and its own error, with the name', () => {
    const r = evaluateM2c(
      TC,
      SPEC,
      'obj',
      'asm',
      scorer({ '*this)': "#   ')' expected", '*this_': "#   undefined identifier 'unk520'" }),
      undefined,
    );
    // the as-emitted text has `*this)`, the renamed one `*this_)`; key off the declarator
    expect(r.outcome).toBe('noncompile');
    expect(r.errorMarkers).toEqual(["#   undefined identifier 'unk520'"]);
    expect(r.source).toContain('this_');
    expect(r.receiverRenamed).toBe('this_');
  });

  test('the as-emitted text compiles: it is published, and no rename is claimed', () => {
    const r = evaluateM2c(TC, SPEC, 'obj', 'asm', scorer({}, ['*this)']), undefined);
    expect(r.outcome).toBe('match');
    expect(r.source).toBe(M2C_SOURCE);
    expect(r.receiverRenamed).toBeUndefined();
  });
});
