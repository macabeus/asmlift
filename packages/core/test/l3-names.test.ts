// The names a function's parameters and locals print under (src/l3/names.ts): the declaration's own
// parameter names, and every refusal that keeps the structurer's name where a new one would change
// what a name means.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { nameVariables } from '../src/l3/names';
import { decompile } from '../src/pipeline';
import type { FnProto } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

const s32 = T.s(32);

/** `s32 f(s32 a0, s32 a1) { return a0 + a1; }`, with `extra` statements ahead of the return. */
const sum = (paramNames?: readonly string[], extra: SFn['body'] = []): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: s32 },
    { name: 'a1', type: s32 },
  ],
  locals: [],
  retType: s32,
  body: [
    ...extra,
    { k: 'return', value: { k: 'bin', op: '+', l: { k: 'var', name: 'a0' }, r: { k: 'var', name: 'a1' } } },
  ],
  ...(paramNames ? { paramNames } : {}),
});

describe("the declaration's parameter names", () => {
  test('print in the signature and at every use', () => {
    expect(cBackend.emit(sum(['x', 'y']))).toBe('s32 f(s32 x, s32 y) {\n    return x + y;\n}\n');
  });

  test('print nothing where they do not pair one to one with the lifted parameters', () => {
    expect(cBackend.emit(sum(['x']))).toContain('s32 f(s32 a0, s32 a1)');
    expect(cBackend.emit(sum(['x', 'y', 'z']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('a name the function already spells keeps the structurer name, and only that one', () => {
    const call = (fn: string): SFn['body'] => [{ k: 'exprstmt', value: { k: 'call', fn, args: [] } }];
    // a callee, which the parameter would shadow
    expect(cBackend.emit(sum(['x', 'y'], call('x')))).toContain('s32 f(s32 a0, s32 y)');
    // a global the body reads
    const reads: SFn['body'] = [{ k: 'store', lval: { k: 'var', name: 'gOut' }, value: { k: 'var', name: 'y' } }];
    expect(cBackend.emit(sum(['x', 'y'], reads))).toContain('s32 f(s32 x, s32 a1)');
    // the function's own name, and another variable's structurer name
    expect(cBackend.emit(sum(['f', 'a0']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('a name a compiler predefines as a macro, or one in the reserved namespace, is not printed', () => {
    expect(cBackend.emit(sum(['linux', 'mips']))).toContain('s32 f(s32 a0, s32 a1)');
    expect(cBackend.emit(sum(['__x', '_Y']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('the C++ backend binds its own names and is left alone', () => {
    const fn = { ...sum(['x', 'y']), dialect: 'c++' as const };
    expect(nameVariables(fn, () => '')).toBe(fn);
  });

  test('a function with nothing to rename is printed once, as it was', () => {
    const fn = sum();
    let asked = 0;
    expect(
      nameVariables(fn, () => {
        asked++;
        return '';
      }),
    ).toBe(fn);
    expect(asked).toBe(0);
  });

  // end to end: the context's own entry carries the names, and the lift prints them
  test('a lift prints the names its own declaration gives', () => {
    const asm = 'f:\n\tlsl\tr0, r0, r1\n\tbx\tlr\n';
    const lift = (ownContextProto: FnProto) => decompile('f', asm, ARMV4T_AGBCC, { ownContextProto }).source;
    // the names only: the declaration's TYPES are no part of this
    expect(lift({ params: ['s32', 'u8'], returns: 's32', paramNames: ['x', 'shift'] })).toContain(
      's32 f(s32 x, s32 shift)',
    );
    expect(lift({ params: ['s32', 'u8'], returns: 's32', paramNames: ['x', 'shift'] })).toContain('x << shift');
    // a parameter that is not one argument word names none
    expect(lift({ params: ['s32', 'float'], returns: 's32', paramNames: ['x', 'shift'] })).not.toContain('shift');
  });
});
