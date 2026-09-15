// A benchmark row's compiler flags as the pages render them (renderToStaticMarkup, no DOM): the strip
// in the function detail, directly above the reference and decompiler columns, and the Function
// Explorer's flags column and level filter. Over `FLAGS_SAMPLE`, whose real units are copied from the
// committed manifests.
import type { FunctionResult } from '@asmlift/bench-schema';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { CompilerFlags } from '../src/pages/benchmark/components/CompilerFlags';
import { Explorer } from '../src/pages/benchmark/components/Explorer';
import { FunctionDetail } from '../src/pages/benchmark/components/FunctionDetail';
import { peerProfile, profileChanges, projectProfiles, rowLevel, rowProfile } from '../src/pages/benchmark/lib/flags';
import { FLAGS_SAMPLE, sampleRow } from './flags-sample';

// The feature picker reads the live fragment through `useSyncExternalStore` over `window`, which a
// server render has no snapshot for. (`vi.mock` is hoisted above the imports.)
vi.mock('../src/shared/utils/hash-adapter', () => ({ useCurrentHash: () => '' }));

const noop = () => {};
const profiles = projectProfiles(FLAGS_SAMPLE);
const peer = (fn: FunctionResult) => peerProfile(profiles, fn);

/** The text a reader sees: tags and React's text separators removed, entities decoded. */
const plain = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
const strip = (fn: FunctionResult, view?: 'effective' | 'raw') =>
  renderToStaticMarkup(<CompilerFlags fn={fn} peer={peer(fn)} initialView={view} />);
/** The flag words as the strip groups them: one entry per group that never wraps apart. */
const groups = (html: string) =>
  html
    .slice(html.indexOf('gap-y-1 font-mono text-slate-200'))
    .split('</div>')[0]
    .split('<span class="whitespace-nowrap">')
    .slice(1)
    .map(plain);

describe('the flags strip', () => {
  test('sits in the function detail directly above the reference and decompiler columns', () => {
    const fn = sampleRow('AbsMax');
    const html = renderToStaticMarkup(
      <FunctionDetail
        fn={fn}
        peer={peer(fn)}
        onClose={noop}
        onOpenInPlayground={noop}
        onOpenFeature={noop}
        hash=""
        onOpenVariation={noop}
      />,
    );
    const at = html.indexOf('aria-label="compiler flags"');
    expect(at).toBeGreaterThan(html.indexOf('</h2>'));
    const columns = html.indexOf('reference source');
    expect(html.indexOf('</section>', at)).toBeLessThan(columns);
    expect(plain(html.slice(html.indexOf('</section>', at), columns))).toBe('');
  });

  test('a row sharing its project’s profile: its flags in build order, the level once, the build commit and unit', () => {
    const html = strip(sampleRow('AbsMax'));
    expect(groups(html)).toEqual(['-fhex-asm', '-mthumb-interwork', '-O2']);
    expect(plain(html)).toContain('Compiler flags-O2from Makefile @ a069e81b ▸ · src/game/math.c');
    expect(plain(html)).toContain("same profile as 2 of sa3's 3 agbcc rows");
    expect(html).not.toContain('◆');
    // the recipe line waits behind its disclosure, and there is no view toggle with nothing overridden
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('tools/agbcc/bin/agbcc');
    expect(html).not.toContain('radiogroup');
  });

  test('a row at another level says how it differs, in the build’s words, behind one marker', () => {
    const html = strip(sampleRow('VerifyFlashSector_Core'));
    expect(plain(html)).toContain("◆ differs from the profile of 2 of sa3's 3 agbcc rows: -O2 → -O1 · no -fhex-asm");
    expect(html.match(/◆/g)).toHaveLength(1);
  });

  test('a word only one side spells is added or missing, whatever slot it sets', () => {
    expect(plain(strip(sampleRow('func_80045350_45F50')))).toContain(
      "◆ differs from the profile of 2 of marioparty3's 4 gcc2.7.2 rows: +-fno-common · no -Wa,--vr4300mul-off",
    );
  });

  test('words the flag table does not name are listed apart; a project with one row of a toolchain has no profile line', () => {
    const html = strip(sampleRow('gfxopen'));
    expect(groups(html)).toEqual(['-G 0', '-non_shared', '-Wab,-r4300_mul', '-mips2', '-EB', '-O2', '-g3']);
    expect(plain(html)).toContain(
      "not in asmlift's flag table (the compiler still receives them): -Wab,-r4300_mul -EB",
    );
    expect(plain(html)).not.toContain('profile');
  });

  test('an option and its arguments never wrap apart, and the raw view strikes every overridden word', () => {
    const fn = sampleRow('fn_1_C2BC');
    const effective = strip(fn);
    expect(groups(effective)).toEqual(['-inline auto', "-pragma 'scheduling off'", '-str reuse, readonly', '-O0,p']);
    expect(effective).toContain('role="radiogroup"');
    const raw = strip(fn, 'raw');
    expect(groups(raw)[0]).toBe('-O4,p');
    expect(raw).toContain('<s class="text-slate-500" title="overridden by a later flag">-O4,p</s>');
    expect(plain(raw)).toContain('from objdiff.json @ 01234567 ▸ · src/REL/m427Dll/map.c');
  });

  test('a synthetic row compiles at its toolchain’s canonical flags, with no build, marker or profile line', () => {
    const html = strip(sampleRow('clamp0'));
    expect(plain(html)).toContain("from mwcc_242_81's canonical flags");
    expect(groups(html).slice(0, 3)).toEqual(['-proc gekko', '-O4,p', '-enum int']);
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('◆');
    expect(plain(html)).not.toContain('profile');
  });
});

describe('the Function Explorer', () => {
  const table = (searchParams: string) => {
    const html = renderToStaticMarkup(
      <NuqsTestingAdapter searchParams={searchParams}>
        <Explorer
          rows={[...FLAGS_SAMPLE]}
          hash=""
          onOpenInPlayground={noop}
          onOpenFeature={noop}
          onOpenVariation={noop}
        />
      </NuqsTestingAdapter>,
    );
    const body = html.slice(html.indexOf('<tbody>'));
    const cells = body
      .split('<tr ')
      .slice(1)
      .map((tr) => ({
        sym: /<td class="px-3 py-2 font-mono text-slate-100">([^<]*)<\/td>/.exec(tr)![1],
        flags: /<div class="max-w-\[220px\] font-mono text-xs">(.*?)<\/div>/.exec(tr)![1],
      }));
    return { html, cells: new Map(cells.map((c) => [c.sym, c.flags])) };
  };

  test('a flags column: the level, and a marker with what else separates the row from its project', () => {
    const { html, cells } = table('');
    expect(html).toContain('>Flags</span>');
    expect(plain(cells.get('AbsMax')!)).toBe('-O2');
    expect(plain(cells.get('VerifyFlashSector_Core')!)).toBe('-O1 ◆ no -fhex-asm');
    // a change of level alone is already the level the cell shows; the marker's title says so
    expect(plain(cells.get('func_8008A0D0_8ACD0')!)).toBe('-O2 ◆');
    expect(cells.get('func_8008A0D0_8ACD0')).toContain('-O1 → -O2');
    expect(plain(cells.get('clamp0')!)).toBe('-O4,p');
    // the cell's title is the whole flag set, in the shell's spelling
    expect(cells.get('fn_1_C2BC')).toContain('title="-O4,p -inline auto -pragma &#x27;scheduling off&#x27;');
  });

  test('the level filter keeps the rows compiled at the level the compiler acts on', () => {
    const { html, cells } = table('opt=-O1');
    expect([...cells.keys()].sort()).toEqual(
      ['VerifyFlashSector_Core', 'func_800600C0_60CC0', 'func_8006014C_60D4C', 'func_80045350_45F50'].sort(),
    );
    const select = html.slice(html.indexOf('>Opt level<'), html.indexOf('</select>', html.indexOf('>Opt level<')));
    expect([...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual([
      '',
      '-O0,p',
      '-O1',
      '-O2',
      '-O4,p',
    ]);
  });
});

describe('the profile a row is compared with', () => {
  test('is the one most of the project’s rows of the toolchain share, whatever the row order', () => {
    const reversed = projectProfiles([...FLAGS_SAMPLE].reverse());
    for (const fn of FLAGS_SAMPLE) {
      expect(peerProfile(reversed, fn), fn.id).toEqual(peer(fn));
    }
    expect(peer(sampleRow('clamp0'))).toBeNull();
    expect(peer(sampleRow('gfxopen'))).toBeNull();
  });

  test('the level is the one the compiler acts on', () => {
    const ido = { ...sampleRow('gfxopen'), cflags: ['-O2', '-g'] };
    expect(rowLevel(ido)).toBe('-O1');
    expect(profileChanges(rowProfile(sampleRow('gfxopen')), rowProfile(ido))[0]).toBe('-O2 → -O1');
  });
});
