// Pin tests for the C++ synthetic specs — the contract that keeps them measurable:
// mwcc-only (the one adapter with a C++ build path) and `extern "C"` on the measured symbol
// (a mangled symbol would break the scorer's name lookup; candidates compile as plain C).
import { describe, expect, test } from 'vitest';

import { SYNTHETIC_CPP } from '../dataset/synthetic';
import { syntheticCases } from '../src/cases/synthetic';

describe('SYNTHETIC_CPP (pinned)', () => {
  test('every spec is c++, mwcc-only, and exports its symbol with C linkage', () => {
    expect(SYNTHETIC_CPP.length).toBeGreaterThan(0);
    for (const spec of SYNTHETIC_CPP) {
      expect(spec.lang, spec.sym).toBe('c++');
      expect(spec.toolchains, spec.sym).toEqual(['mwcc-ppc']);
      expect(spec.src, spec.sym).toContain(`extern "C"`);
      expect(spec.src, spec.sym).toContain(spec.sym);
    }
  });

  test('the c++ specs become cases (the silent-absence regression guard)', () => {
    const ids = syntheticCases().map((c) => c.id);
    for (const spec of SYNTHETIC_CPP) {
      expect(ids).toContain(`synthetic:${spec.sym}:mwcc-ppc`);
    }
  });
});
