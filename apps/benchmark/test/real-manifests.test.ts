// The portability policy, enforced: every committed real-tier manifest must parse, validate,
// and carry no machine paths. A manifest that regresses to an absolute root fails CI here, not
// on some other machine's broken clone.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { REAL_DIR, type RealManifest, resolveProjectRoot, validateManifest } from '../src/cases/manifests';
import { ELF_MAKE_TARGET, makefileHasAsmliftElf } from '../src/cases/project-elf';

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
      // every real project pins its benchmark fork + integration branch (bench setup clones it)
      expect(man.repo, `${f}: repo must be owner/name`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      expect(man.branch, `${f}: pinned branch`).toBe('asmlift-benchmark');
      // include flags must be project-relative, never absolute
      for (const flag of man.cppIncludes) {
        expect(flag, `absolute include flag in ${f}`).not.toMatch(/^\/|-I\//);
      }
    });

    // `elfMake` is what makes the published repro script name the derive step; a project whose
    // checkout HAS the target and whose manifest omits it publishes a script that stops at the
    // plain build, handing the reader a different symbol map than the rows were measured with
    // (kleod, before this gate: 593 addrs / 0 volatile against the 675 / 81 the rows used).
    test(`${f} names the derived-ELF make target`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      // Checkout-free half — true of all six projects today, because all six declare a DERIVED
      // `tools.asmlift.elf`. Relax it only for a project whose plain build produces its declared
      // ELF (and then the checkout-aware half below is the one that must stay green).
      expect(man.elfMake, `${f}: every real project derives its symbol-source ELF today`).toBe(ELF_MAKE_TARGET);
      // Checkout-aware half — the real invariant, exact in both directions. Vacuous where the
      // checkout is absent (CI clones none), which is why the half above exists.
      const root = resolveProjectRoot(man);
      if (existsSync(join(root, 'Makefile'))) {
        expect(
          Boolean(man.elfMake),
          `${f}: elfMake must be set iff ${root}/Makefile exposes \`${ELF_MAKE_TARGET}\``,
        ).toBe(makefileHasAsmliftElf(root));
      }
    });

    // A row's `addr` is its identity, so it is a MEASUREMENT: the address the project's own ELF gives
    // the symbol, read here back out of the committed symbol map that ELF was vendored into — no
    // checkout needed, so CI holds it. A typo'd or guessed address would join the wrong rows.
    test(`${f} keys every row by the address its vendored symbol map gives the symbol`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const mapPath = join(REAL_DIR, 'tu', man.project, 'symbols.json.gz');
      expect(existsSync(mapPath), `${man.project} has no vendored symbol map to check addr against`).toBe(true);
      const map = JSON.parse(gunzipSync(readFileSync(mapPath)).toString('utf8')) as Record<string, { name: string }[]>;
      const at = new Map<string, string[]>();
      for (const [addr, entries] of Object.entries(map)) {
        for (const e of entries) {
          at.set(e.name, [...(at.get(e.name) ?? []), addr]);
        }
      }
      const wrong = man.functions
        .filter((fn) => JSON.stringify(at.get(fn.sym)) !== JSON.stringify([fn.addr]))
        .map((fn) => `${man.project}:${fn.sym} addr ${fn.addr}, map ${JSON.stringify(at.get(fn.sym) ?? null)}`);
      expect(wrong).toEqual([]);
    });

    // AN ADDRESS IS AN IDENTITY ONLY IF ONE FUNCTION LIVES THERE. N64 VRAM is not unique by
    // construction — overlays reuse it, and the linked ELFs carry addresses holding more than one
    // FUNC name (marioparty3 1,605 of them, snowboardkids2 20, af 5). No row sits on one today, and
    // this keeps it that way: a row added at an overlay address would otherwise join a removed row
    // at the same VRAM across two artifacts without a word.
    test(`${f} puts every row at an address holding exactly one code symbol`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const map = JSON.parse(
        gunzipSync(readFileSync(join(REAL_DIR, 'tu', man.project, 'symbols.json.gz'))).toString('utf8'),
      ) as Record<string, { name: string; kind?: string }[]>;
      const shared = man.functions
        .map((fn) => ({ fn, code: (map[fn.addr] ?? []).filter((e) => e.kind !== 'data').map((e) => e.name) }))
        .filter(({ code }) => code.length !== 1)
        .map(({ fn, code }) => `${man.project}:${fn.sym} at ${fn.addr} shares it with ${JSON.stringify(code)}`);
      expect(shared).toEqual([]);
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

    // A unit's flags are copied from the build at the commit its TUs were vendored from. A pin bump that
    // re-vendors without re-deriving (or the reverse) leaves the two commits apart, and fails here.
    test(`${f} derives every unit's flags at the commit its TUs were vendored from`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const prov = JSON.parse(readFileSync(join(REAL_DIR, 'tu', man.project, 'PROVENANCE.json'), 'utf8')) as {
        commit: string;
      };
      const stale = Object.entries(man.units)
        .filter(([, u]) => u.flagsFrom.commit !== prov.commit)
        .map(([path, u]) => `${man.project}:${path} flags from ${u.flagsFrom.commit}, TUs from ${prov.commit}`);
      expect(stale).toEqual([]);
    });
  }
});
