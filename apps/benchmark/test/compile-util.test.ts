// Pin tests for compilerDiagnostics — the compile modules embed its output in the Error
// messages that become row error markers, so it must surface real diagnostics, not banners.
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { compilerDiagnostics, pickDiagnostics, restated, scratchSlot } from '../src/compile/util';

describe('compilerDiagnostics (pinned)', () => {
  test('pre-3.0 gcc diagnostics (no "error" keyword) survive via their file:line prefix', () => {
    const gcc2 = [
      "c.i: In function `func_80018DC0':",
      "c.i:12: `sp' undeclared (first use in this function)",
      'c.i:12: (Each undeclared identifier is reported only once',
      'c.i:12: for each function it appears in.)',
      "c.i:31: parse error before `.'",
    ].join('\n');
    const out = compilerDiagnostics(gcc2);
    expect(out).toContain("c.i:12: `sp' undeclared (first use in this function)");
    expect(out).toContain("c.i:31: parse error before `.'");
    expect(out).not.toContain('In function'); // the banner has no line number and is not a diagnostic
  });

  test('mwcc caret lines carry their explanation from the NEXT line', () => {
    const mwcc = [
      '### mwcceppc.exe Compiler:',
      '#    File: cand.c',
      '# ---------------',
      '#      12:     *arg0 = (s32) (*arg0 + 1);',
      '#   Error:             ^',
      '#   illegal use of incomplete struct/union/class',
    ].join('\n');
    const out = compilerDiagnostics(mwcc);
    expect(out).toContain('illegal use of incomplete struct/union/class');
  });

  test('keyword-style errors still match, banners lose to them', () => {
    const out = compilerDiagnostics('some banner\nld: fatal error: symbol not found\ntrailing');
    expect(out).toBe('ld: fatal error: symbol not found');
  });

  test('falls back to the leading non-empty lines when nothing looks like a diagnostic', () => {
    expect(compilerDiagnostics('\n\nsegmentation fault\n')).toBe('segmentation fault');
    expect(compilerDiagnostics('')).toBe('');
  });

  test('an error below more warnings than the cap holds is what the cap keeps', () => {
    const stderr = [
      ...Array.from({ length: 6 }, (_, i) => `c.c:${i + 1}: warning: assignment from incompatible pointer type`),
      "c.c:9: too many arguments to function `thunk_HeapFree'",
    ].join('\n');
    const lines = compilerDiagnostics(stderr).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("c.c:9: too many arguments to function `thunk_HeapFree'");
    expect(lines.slice(1)).toEqual(
      [1, 2, 3, 4].map((n) => `c.c:${n}: warning: assignment from incompatible pointer type`),
    );
  });

  test('caps at 5 lines of 240 chars', () => {
    const many = Array.from({ length: 9 }, (_, i) => `c.i:${i}: ${'x'.repeat(300)}`).join('\n');
    const lines = compilerDiagnostics(many).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.length <= 240)).toBe(true);
  });
});

describe('pickDiagnostics (pinned)', () => {
  test('deduplicates a message line that both follows a caret and matches on its own', () => {
    const picked = pickDiagnostics(['#   Error:  ^', '#   error: the real message']);
    expect(picked).toEqual(['#   Error:  ^', '#   error: the real message']);
  });

  // The FIRST line of a captured message carries the harness's own wrapper, so a diagnostic block
  // that OPENS on a caret line still has to hand over the next line — otherwise the row publishes
  // a bare `^` as the cause it was judged on.
  test('a caret line keeps its explanation even behind the wrapper prefix', () => {
    expect(pickDiagnostics(['mwcceppc failed: #   Error:      ^', '#   type mismatch'])).toEqual([
      'mwcceppc failed: #   Error:      ^',
      '#   type mismatch',
    ]);
  });

  test('returns [] when nothing matches', () => {
    expect(pickDiagnostics(['banner', 'more banner'])).toEqual([]);
  });
});

describe('compilerDiagnostics is machine-independent', () => {
  test('an absolute temp path collapses to its basename', () => {
    const agbcc =
      'agbcc failed\n' +
      "/var/folders/q_/6tsqtbsd2ks6l381b5yc8fvh0000gn/T/bench-cand-lIW6hf/c.c:1076: `gBgDataPtrs' undeclared";
    expect(compilerDiagnostics(agbcc)).toBe("c.c:1076: `gBgDataPtrs' undeclared");
  });

  test('two runs of the same failure differ only by their mkdtemp suffix, and now agree', () => {
    const at = (dir: string) => compilerDiagnostics(`/tmp/${dir}/c.c:12: invalid operands to binary <<`);
    expect(at('bench-cand-8113VC')).toBe(at('bench-cand-5F2Xyi'));
  });

  test('a relative path is left alone', () => {
    expect(compilerDiagnostics('c.i:12: parse error')).toBe('c.i:12: parse error');
  });
});

describe('scratchSlot (the leak fix)', () => {
  test('one directory across calls, EMPTIED each time — so a stale sibling can never be read', () => {
    const slot = scratchSlot('bench-slot-test-');
    const first = slot();
    writeFileSync(join(first, 'left-behind'), 'x');
    const second = slot();
    expect(second).toBe(first); // one directory, not one per call
    expect(existsSync(join(second, 'left-behind'))).toBe(false); // emptied, so a missing output stays LOUD
    rmSync(first, { recursive: true, force: true });
  });
});

describe('restated', () => {
  // The docker seams' throws are re-worded with the bounded diagnostic the row publishes; what
  // they must not lose is the KIND, which is the only thing the stillborn rule reads.
  test('a rejection stays a rejection, its whole diagnostic intact behind the bounded message', () => {
    const diagnostic = Array.from({ length: 9 }, (_, i) => `c.c:${i + 1}: parse error before \`;'`).join('\n');
    const e = restated('kmc gcc', new CompilerRejection(`kmc gcc (docker) failed: ${diagnostic}`, diagnostic));
    expect(e).toBeInstanceOf(CompilerRejection);
    expect((e as CompilerRejection).diagnostic).toBe(diagnostic);
    expect(e.message.startsWith('kmc gcc failed: ')).toBe(true);
    expect(e.message.split('\n')).toHaveLength(5);
  });

  test('a transient stays a plain Error', () => {
    const e = restated('kmc gcc', new Error('kmc gcc (docker) did not run to completion (exit 137)'));
    expect(e).not.toBeInstanceOf(CompilerRejection);
    expect(e.message).toContain('exit 137');
  });
});
