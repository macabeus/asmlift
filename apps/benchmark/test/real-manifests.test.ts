// The portability policy, enforced: every committed real-tier manifest must parse, validate,
// and carry no machine paths. A manifest that regresses to an absolute root fails CI here, not
// on some other machine's broken clone.
import { moduleLocation, moduleOf } from '@asmlift/bench-schema';
import { PLACEMENT_STRIDE } from '@asmlift/cli/module-elf';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import {
  REAL_DIR,
  type RealManifest,
  resolveProjectRoot,
  validateManifest,
  vendoredMapFile,
} from '../src/cases/manifests';
import { ELF_MAKE_TARGET, makefileHasAsmliftElf } from '../src/cases/project-elf';

const files = readdirSync(REAL_DIR).filter((f) => f.endsWith('.json'));
const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/var\//;

type MapJson = Record<string, { name: string; kind?: string }[]>;

/** The vendored map a row of this `addr` is read with — the project's, or its REL module's — as
 *  raw JSON, plus name → the keys it sits at. Read and indexed once per map: these maps run to
 *  hundreds of thousands of entries, and a project has 42 rows. */
const mapCache = new Map<string, { map: MapJson; at: Map<string, string[]> }>();
function mapFor(man: RealManifest, addr: string): { map: MapJson; at: Map<string, string[]> } {
  const path = vendoredMapFile(join(REAL_DIR, 'tu', man.project), moduleOf(addr));
  let cached = mapCache.get(path);
  if (cached === undefined) {
    expect(existsSync(path), `${man.project} has no vendored symbol map at ${path} to check addr against`).toBe(true);
    const map = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as MapJson;
    const at = new Map<string, string[]>();
    for (const [key, entries] of Object.entries(map)) {
      for (const e of entries) {
        at.set(e.name, [...(at.get(e.name) ?? []), key]);
      }
    }
    cached = { map, at };
    mapCache.set(path, cached);
  }
  return cached;
}

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

    // A row's `addr` is its identity, so it is a MEASUREMENT: where the project's own ELF puts the
    // symbol, read here back out of the committed symbol map that ELF was vendored into — no
    // checkout needed, so CI holds it. A typo'd or guessed address would join the wrong rows.
    //
    // A REL row is read out of its MODULE's map, and the keys there are the synthetic bases the
    // module's sections were placed at (cli/module-elf), never the game's addresses — so what is
    // held is the half of the identity a person types: the symbol appears at exactly one key, and
    // that key's offset within its section is the row's. The SECTION is not checkable from the map
    // (placement records an index, not a name); `bench vendor` is where that is proved.
    test(`${f} keys every row where its vendored symbol map puts the symbol`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const wrong: string[] = [];
      for (const fn of man.functions) {
        const keys = mapFor(man, fn.addr).at.get(fn.sym) ?? [];
        const loc = moduleLocation(fn.addr);
        const ok =
          loc === undefined
            ? JSON.stringify(keys) === JSON.stringify([fn.addr])
            : keys.length === 1 && Number.parseInt(keys[0], 16) % PLACEMENT_STRIDE === loc.offset;
        if (!ok) {
          wrong.push(`${man.project}:${fn.sym} addr ${fn.addr}, map ${JSON.stringify(keys)}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    // AN ADDRESS IS AN IDENTITY ONLY IF ONE FUNCTION LIVES THERE. N64 VRAM is not unique by
    // construction — overlays reuse it, and the linked ELFs carry addresses holding more than one
    // FUNC name (marioparty3 1,605 of them, snowboardkids2 20, af 5). No row sits on one today, and
    // this keeps it that way: a row added at an overlay address would otherwise join a removed row
    // at the same VRAM across two artifacts without a word. A REL row is checked at the key its own
    // module's map gives it, which is the same question one module down.
    test(`${f} puts every row where exactly one code symbol lives`, () => {
      const man = JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest;
      const shared = man.functions
        .map((fn) => {
          const { map, at } = mapFor(man, fn.addr);
          const key = moduleLocation(fn.addr) === undefined ? fn.addr : ((at.get(fn.sym) ?? [])[0] ?? fn.addr);
          return { fn, key, code: (map[key] ?? []).filter((e) => e.kind !== 'data').map((e) => e.name) };
        })
        .filter(({ code }) => code.length !== 1)
        .map(({ fn, key, code }) => `${man.project}:${fn.sym} at ${key} shares it with ${JSON.stringify(code)}`);
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
