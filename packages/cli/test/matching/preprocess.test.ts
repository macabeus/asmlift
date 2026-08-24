// THE PREPROCESSOR STEP on the agbcc path (toolchains/compile.ts). agbcc is `cc1` — it reads
// PREPROCESSED C and its lexer cannot skip a comment — so `cpp` runs ahead of it, and on this
// machine that one step is four processes (`sh`, the `cpp` shim, the gcc driver, `cc1 -E`) and
// most of a candidate compile. `needsPreprocessing` is what lets a candidate spelling skip it,
// and the whole safety of that rests on ONE claim: where the predicate says no, `cpp -P
// -nostdinc` returns the bytes it was given.
import { C_TYPEDEFS } from '@asmlift/core/target';
import { compileCandAgbcc, needsPreprocessing } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/** A candidate spelling, as the C backend prints one. */
const PLAIN = [
  's32 f(s32 a0) {\n    return a0 * 3;\n}\n',
  'void f(u8 *a0, s32 a1) {\n    while (a1 != 0) {\n        *a0 = 0;\n        a0 = a0 + 1;\n        a1 = a1 - 1;\n    }\n}\n',
  'u32 f(void) {\n    return *(volatile u32 *)0x4000006;\n}\n',
];

describe('the preprocessor runs where there is something to preprocess', () => {
  test.each([
    ['a directive', '#define N 3\ns32 f(void) { return N; }\n'],
    ['a block comment', '/* asmlift could not decompile … */\n'],
    ['a line comment', 's32 f(void) { return 0; } // why\n'],
    ['a line splice', 's32 f(void) { return \\\n0; }\n'],
    ['a CR', 's32 f(void) { return 0; }\r\n'],
    ['no trailing newline', 's32 f(void) { return 0; }'],
    ['a predefined macro, with no # anywhere', 's32 f(void) { return __STDC__; }\n'],
    ['a BUILT-IN macro, which `-dM` never lists', 's32 f(void) { return __LINE__; }\n'],
    ['…including the ones that are not', 's32 f(void) { return __COUNTER__ + __INCLUDE_LEVEL__; }\n'],
    ['a libgcc callee, reserved and so conservatively preprocessed', 's32 f(s32 a0) { return __ashrdi3(a0); }\n'],
  ])('%s takes the preprocessor', (_what, text) => {
    expect(needsPreprocessing(text)).toBe(true);
  });

  test('a candidate spelling does not', () => {
    for (const src of PLAIN) {
      expect(needsPreprocessing(C_TYPEDEFS + src)).toBe(false);
    }
  });

  // `_pad0` is what declare.ts names a struct gap, and it is in NO reserved namespace — the rule
  // has to admit it, or the fast path never fires on a function that recovered a struct.
  test('a struct-padding field is not a reserved name', () => {
    const withPad = 'struct S { u8 f0; u8 _pad0[3]; u32 f4; };\nu32 f(struct S *a0) {\n    return a0->f4;\n}\n';
    expect(needsPreprocessing(C_TYPEDEFS + withPad)).toBe(false);
  });

  // The claim the skip rests on. Skipping is only sound because there is nothing to skip: the
  // preprocessor is the identity on this text, so the compiler reads the same bytes either way.
  test('…and `cpp -P -nostdinc` is the identity on it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-pp-test-'));
    const cPath = join(dir, 'in.c');
    const ppPath = join(dir, 'in.pp.c');
    for (const src of PLAIN) {
      const text = C_TYPEDEFS + src;
      writeFileSync(cPath, text);
      const r = spawnSync('sh', ['-c', `cpp -P -nostdinc ${cPath} > ${ppPath} 2>/dev/null`]);
      expect(r.status).toBe(0);
      expect(readFileSync(ppPath, 'utf8')).toBe(text);
    }
  });

  // The annotate-mode stub (`onGap: "annotate"`) is ALL comment, and agbcc answers a `/*` with
  // `syntax error before '/'` — so that source must still reach the preprocessor.
  test('an all-comment annotate stub still compiles', () => {
    const stub = '/* asmlift could not decompile ‘f’ — lift: no reaching compare */\n';
    expect(needsPreprocessing(C_TYPEDEFS + stub)).toBe(true);
    expect(() => compileCandAgbcc(stub)).not.toThrow();
  });
});
