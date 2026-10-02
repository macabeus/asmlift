// A real row's prototype table (src/cases/context-proto.ts): the vendored context's declarations
// under the manifest's own entries, without the row's own declaration, narrowed to what the
// assembly names before it is published.
import { type Language, parseDeclarations } from '@asmlift/core/cdecl/parse';
import { unitLanguage } from '@asmlift/core/codegen-flags';
import { validatePrototypes } from '@asmlift/core/proto';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { m2cDeclarations, referencedPrototypes, rowPrototypes } from '../src/cases/context-proto';
import { loadManifests } from '../src/cases/manifests';

const at = (ctxI: string, ctxFile = 'test/ctx.i') => ({ ctxI, ctxFile });
const CTX = 'typedef signed long s32; s32 callee(s32 a); s32 other(s32 a, s32 b); void self(s32 x);';

describe('a real row prototype table', () => {
  test('context declarations under the manifest, which wins per symbol, and never the row itself', () => {
    const p = rowPrototypes({ other: { params: 3 } }, at(CTX), 'c', 'self', undefined, ARMV4T_AGBCC);
    expect(p).toEqual({ callee: { returns: 's32', params: ['s32'] }, other: { params: 3 } });
  });

  test('per name: a sized context entry over the map, a spellable map signature over an unsized entry', () => {
    const ctx =
      'typedef signed long s32; typedef struct S { s32 v; } S; s32 callee(s32 a); void byval(S s); void opaque(S s);';
    const code = (name: string, params: { size: number; signed: boolean | null }[]) => ({
      name,
      kind: 'code' as const,
      signature: { params, returns: null },
    });
    const map = new Map([
      [0x100, [code('callee', [])]],
      [0x104, [code('byval', [{ size: 4, signed: null }])]],
      // a signless narrow parameter spells nothing, so the map states no prototype for it
      [0x108, [code('opaque', [{ size: 2, signed: null }])]],
    ]);
    expect(rowPrototypes(undefined, at(ctx, 'precedence.i'), 'c', 'self', map as never, ARMV4T_AGBCC)).toEqual({
      callee: { returns: 's32', params: ['s32'] },
      opaque: { returnsVoid: true, params: ['S'] },
    });
  });

  test('an empty context leaves the manifest table as it is', () => {
    expect(rowPrototypes(undefined, at(''), 'c', 'self', undefined, ARMV4T_AGBCC)).toBeUndefined();
    expect(rowPrototypes({ self: { returnsVoid: true } }, at(''), 'c', 'self', undefined, ARMV4T_AGBCC)).toEqual({
      self: { returnsVoid: true },
    });
  });

  test('publishes only the entries the assembly names, plus the row own', () => {
    const p = rowPrototypes({ self: { returnsVoid: true } }, at(CTX), 'c', 'self', undefined, ARMV4T_AGBCC);
    const asm = 'self:\n  mflr r0\n  bl callee\n  blr\n';
    expect(referencedPrototypes(p, asm, 'self')).toEqual({
      self: { returnsVoid: true },
      callee: { returns: 's32', params: ['s32'] },
    });
    expect(referencedPrototypes(undefined, asm, 'self')).toBeUndefined();
  });
});

describe('what m2c is given where it gets no project context', () => {
  test('the same entries in their own spellings, each project type declared opaque, nothing unsized', () => {
    const proto = {
      self: { returnsVoid: true, params: [] },
      probe: { returns: 'int', params: ['s32', 'size_t'] },
      lock: { returnsVoid: true, params: ['OSMutex *'] },
      mount: { returns: 's32', params: ['s32', 'struct Card *', 'void (*)(s32 chan, s32 result)'] },
      byval: { returnsVoid: true, params: ['Vec'] },
      declared: { returns: 's32', params: ['s32'] },
      opaque: { params: ['s32'] },
    };
    expect(m2cDeclarations(proto, 'self', 's32 declared(s32 x);').split('\n')).toEqual([
      'typedef unsigned int size_t;',
      'typedef struct OSMutex OSMutex;',
      'struct Card;',
      'int probe(s32, size_t);',
      'void lock(OSMutex *);',
      's32 mount(s32, struct Card *, void (*)(s32, s32));',
    ]);
  });
});

/** Every vendored context's text, by `<project>/<file>`. */
function vendoredContexts(): [string, string][] {
  const root = join(import.meta.dirname, '..', 'dataset', 'real', 'tu');
  return readdirSync(root).flatMap((project) =>
    readdirSync(join(root, project))
      .filter((f) => f.startsWith('ctx-'))
      .map((f): [string, string] => [
        `${project}/${f}`,
        gunzipSync(readFileSync(join(root, project, f))).toString('utf8'),
      ]),
  );
}

describe('every vendored context', () => {
  test('parses to a table the CLI --proto accepts', () => {
    const contexts = vendoredContexts();
    for (const [name, text] of contexts) {
      for (const language of ['c', 'c++'] as const) {
        expect(validatePrototypes(prototypesFromContext(text, language)), `${name} (${language})`).toEqual([]);
      }
    }
    expect(contexts.length).toBeGreaterThan(100);
  }, 120_000);

  test('is read whole in the dialect its rows read it in: some declarations, nothing left unread', () => {
    const dialects = rowDialects();
    const unread = vendoredContexts().flatMap(([name, text]) =>
      // a context no row reads is read as C++, whose keywords are C's and more
      [...(dialects.get(name) ?? ['c++' as const])].flatMap((language) => {
        const { declarations, tokens, unread } = parseDeclarations(text, language);
        return [
          ...(declarations.length === 0 ? [`${name} (${language}): no declaration`] : []),
          ...unread.map(
            (k) => `${name} (${language}):${text.slice(0, tokens.start(k)).split('\n').length}: ${tokens.text(k)}`,
          ),
        ];
      }),
    );
    expect(unread).toEqual([]);
  }, 120_000);
});

/** The dialects the real tier reads each vendored context in, by `<project>/<file>`. */
function rowDialects(): Map<string, Set<Language>> {
  const out = new Map<string, Set<Language>>();
  for (const man of loadManifests()) {
    for (const f of man.functions) {
      const { ctxFile } = man.vendored(f.sym);
      out.set(ctxFile, (out.get(ctxFile) ?? new Set()).add(unitLanguage(f.unit, man.units[f.unit].cflags)));
    }
  }
  return out;
}
