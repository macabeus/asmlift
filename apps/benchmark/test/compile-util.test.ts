// Pin tests for compilerDiagnostics — the compile modules embed its output in the Error
// messages that become row error markers, so it must surface real diagnostics, not banners.
import { describe, expect, test } from 'vitest';

import { compilerDiagnostics, pickDiagnostics } from '../src/compile/util';

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

  test('returns [] when nothing matches', () => {
    expect(pickDiagnostics(['banner', 'more banner'])).toEqual([]);
  });
});
