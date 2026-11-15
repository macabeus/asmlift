import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { BinOp, Expr, SFn, Stmt } from '../src/l3/ast';
import { polished } from '../src/l3/polish';

/** The C backend through the polish, at an optimizing level. */
const pc = polished(cBackend, { literal: false });

const v = (name: string): Expr => ({ k: 'var', name });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const s32 = T.int(32, true);
const local = (name: string, extra: Partial<SFn['locals'][number]> = {}): SFn['locals'][number] => ({
  name,
  type: s32,
  ...extra,
});

const fnOf = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: s32 }],
  locals,
  retType: s32,
  body,
});

describe('names: locals numbered densely in first-use order', () => {
  test('renames by first mention and keeps declaration positions; an unused local is numbered last', () => {
    const fn = fnOf(
      [local('v5'), local('v0'), local('v7'), local('v2')],
      [
        { k: 'assign', name: 'v2', value: v('a0') },
        { k: 'assign', name: 'v5', value: bin('+', v('v2'), v('a0')) },
        { k: 'return', value: bin('*', v('v5'), v('v2')) },
      ],
    );
    expect(pc.emit(fn)).toBe(
      's32 f(s32 a0) {\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 v0;\n    v0 = a0;\n    v1 = v0 + a0;\n    return v1 * v0;\n}\n',
    );
    // the draft keeps the tree's names, which the variation names spell
    expect(pc.draft!(fn)).toContain('    s32 v7;');
  });

  test('an unused local stays declared at every level: at -O0 it holds a frame slot', () => {
    const fn = fnOf(
      [local('v0'), local('v1'), local('v2')],
      [
        { k: 'assign', name: 'v0', value: v('a0') },
        { k: 'assign', name: 'v2', value: v('v0') },
        { k: 'return', value: bin('+', v('v2'), v('a0')) }, // no local is the `result`
      ],
    );
    // renamed — a name is no frame slot — with the unused one numbered after the used ones
    const want = '    s32 v0;\n    s32 v2;\n    s32 v1;\n';
    expect(polished(cBackend, { literal: true }).emit(fn)).toContain(want);
    expect(pc.emit(fn)).toContain(want);
  });

  test('a local named on purpose keeps its name and takes no number', () => {
    const fn = fnOf(
      [local('i'), local('v3')],
      [
        { k: 'assign', name: 'i', value: v('a0') },
        { k: 'assign', name: 'v3', value: v('i') },
        { k: 'return', value: bin('+', v('v3'), v('a0')) }, // no local is the `result`
      ],
    );
    expect(pc.emit(fn)).toContain('    s32 i;\n    s32 v0;\n');
  });

  test('a number a role name frees is taken by the next local, in the same rename', () => {
    const fn = fnOf(
      [local('v0'), local('v3')],
      [
        { k: 'assign', name: 'v3', value: v('a0') },
        { k: 'assign', name: 'v0', value: { k: 'const', value: 0 } },
        {
          k: 'while',
          cond: bin('<', v('v0'), { k: 'const', value: 4 }),
          body: [
            { k: 'exprstmt', value: { k: 'call', fn: 'work', args: [v('v3')] } },
            { k: 'assign', name: 'v0', value: bin('+', v('v0'), { k: 'const', value: 1 }) },
          ],
        },
        { k: 'return', value: bin('+', v('v3'), v('a0')) },
      ],
    );
    const out = pc.emit(fn);
    expect(out).toContain('    s32 i;\n    s32 v0;\n');
    expect(out).toContain('work(v0);');
  });

  test('a collision with any other name the function uses skips the renumbering', () => {
    const fn = fnOf(
      [local('v3')],
      [
        { k: 'assign', name: 'v3', value: v('v0') }, // `v0` is a global here
        { k: 'return', value: bin('+', v('v3'), v('a0')) }, // no local is the `result`
      ],
    );
    expect(pc.emit(fn)).toContain('    s32 v3;\n    v3 = v0;');
  });

  test('an unused volatile, frame or array local keeps its name', () => {
    const fn = fnOf(
      [
        local('v0', { volatile: true }),
        local('v1', { frame: { loads: 0, stores: 0 } }),
        { name: 'v2', type: T.array(T.int(8, false), 4) },
      ],
      [{ k: 'return', value: v('a0') }],
    );
    const out = pc.emit(fn);
    expect(out).toContain('volatile s32 v0;');
    expect(out).toContain('s32 v1;');
    expect(out).toContain('u8 v2[4];');
  });
});
