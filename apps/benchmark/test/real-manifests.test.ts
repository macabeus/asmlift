// The portability policy, enforced: every committed real-tier manifest must parse, validate,
// and carry no machine paths. A manifest that regresses to an absolute root fails CI here, not
// on some other machine's broken clone.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { REAL_DIR, type RealManifest, validateManifest } from '../src/cases/manifests';

const files = readdirSync(REAL_DIR).filter((f) => f.endsWith('.json'));
const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

describe('committed real-tier manifests', () => {
  test('there are manifests to police', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`${f} parses, validates, and is portable`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      expect(validateManifest(man, f)).toEqual([]);
      // no machine paths anywhere in the manifest — the single biggest publishing blocker
      const raw = readFileSync(join(REAL_DIR, f), 'utf8');
      expect(raw).not.toMatch(/\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/|[A-Z]:\\\\/);
      // repoDir is a bare directory name, not a path
      expect(man.repoDir).not.toMatch(/^[/.]/);
      // include flags must be project-relative, never absolute
      for (const flag of man.cppIncludes) {
        expect(flag, `absolute include flag in ${f}`).not.toMatch(/^\/|-I\//);
      }
    });

    test(`${f} has vendored TUs for every function, free of machine paths`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const dir = join(REAL_DIR, 'tu', man.project);
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<
        string,
        { tu: string; ctx: string }
      >;
      for (const fn of man.functions) {
        const entry = index[fn.sym];
        expect(entry, `${man.project}:${fn.sym} missing from vendored index`).toBeDefined();
        for (const blob of [entry.tu, entry.ctx]) {
          const text = gunzipSync(readFileSync(join(dir, blob))).toString('utf8');
          expect(text, `machine path inside ${man.project}/${blob}`).not.toMatch(MACHINE_PATH);
        }
      }
      // provenance is part of the dataset
      const prov = JSON.parse(readFileSync(join(dir, 'PROVENANCE.json'), 'utf8'));
      expect(typeof prov.commit).toBe('string');
    });
  }
});
