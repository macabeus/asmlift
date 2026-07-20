// IDO / SGI Pascal backend — the THIRD language target.
// Proves the language-backend seam end-to-end on a DIFFERENT ISA (MIPS): reference C → IDO
// compile → MIPS object (scoring target) + disassembly → asmlift decompile emitting IDO
// Pascal → IDO `upas` recompile → REAL objdiff score. Byte-exact (0) means asmlift's Pascal
// reproduces IDO's exact codegen for the C target.
//
// The point is the DIALECT: SGI Pascal's `and`/`or`/`not` are boolean-only, so bitwise and
// shift ops are the intrinsic functions bitand/bitor/bitxor/bitnot/lshift/rshift — verified
// here to compile AND match, which generic Turbo/Delphi Pascal operators would not.
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { T } from '@asmlift/core/ir/types';
import type { SFn } from '@asmlift/core/l3/ast';
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, scorePascalMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const P = (name: string, params: string, body: string) =>
  `function ${name}(${params}): Integer;\nbegin\n  ${name} := ${body};\nend;\n`;

const CASES: { sym: string; c: string; expect: string }[] = [
  { sym: 'add1', c: 'int add1(int x){ return x + 1; }', expect: P('add1', 'a0: Integer', '(a0 + 1)') },
  {
    sym: 'addab',
    c: 'int addab(int a,int b){ return a + b; }',
    expect: P('addab', 'a0: Integer; a1: Integer', '(a0 + a1)'),
  },
  {
    sym: 'orab',
    c: 'int orab(int a,int b){ return a | b; }',
    expect: P('orab', 'a0: Integer; a1: Integer', 'bitor(a0, a1)'),
  },
  {
    sym: 'andab',
    c: 'int andab(int a,int b){ return a & b; }',
    expect: P('andab', 'a0: Integer; a1: Integer', 'bitand(a0, a1)'),
  },
  {
    sym: 'xorab',
    c: 'int xorab(int a,int b){ return a ^ b; }',
    expect: P('xorab', 'a0: Integer; a1: Integer', 'bitxor(a0, a1)'),
  },
  { sym: 'shl3', c: 'int shl3(int a){ return a << 3; }', expect: P('shl3', 'a0: Integer', 'lshift(a0, 3)') },
  { sym: 'asr2', c: 'int asr2(int a){ return a >> 2; }', expect: P('asr2', 'a0: Integer', 'rshift(a0, 2)') },
  { sym: 'negf', c: 'int negf(int x){ return -x; }', expect: P('negf', 'a0: Integer', '(-a0)') },
  { sym: 'notf', c: 'int notf(int x){ return ~x; }', expect: P('notf', 'a0: Integer', 'bitnot(a0)') },
  // Signed division: IDO Pascal `div` MATCHES C `/` byte-exact (unlike `mod` — see below). The hw
  // divide is recovered by the MIPS frontend (div/mflo, DIVMUL) and lowered to `div`.
  { sym: 'ddiv', c: 'int ddiv(int a){ return a / 3; }', expect: P('ddiv', 'a0: Integer', '(a0 div 3)') },
];

describe('IDO Pascal backend (MIPS): decompile → upas recompile → objdiff', () => {
  for (const { sym, c, expect: golden } of CASES) {
    test(`${sym}`, () => {
      const { obj, asm } = compileMipsTarget(c, sym);
      const p = decompile(sym, asm, MIPS_IDO, { backend: pascalBackend }).source;
      expect(p).toBe(golden);
      const s = scorePascalMips(p, sym, obj);
      if (!s.match) {
        console.log(`emitted Pascal for ${sym}:\n${p}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// Signed REMAINDER has no faithful IDO Pascal spelling: `mod` is ISO (result in [0,n)), which
// mis-scores against C's truncated `%` (verified: `a mod 3` scores 3, not 0). The backend must fail
// LOUD on `%` rather than emit a silently-wrong `mod`.
test('Pascal backend fails loud on signed remainder (no faithful `mod` spelling)', () => {
  const smod: SFn = {
    name: 'rem',
    params: [{ name: 'a0', type: T.s() }],
    locals: [],
    retType: T.s(),
    body: [{ k: 'return', value: { k: 'bin', op: '%', l: { k: 'var', name: 'a0' }, r: { k: 'const', value: 3 } } }],
  };
  expect(() => pascalBackend.emit(smod)).toThrow(/no faithful IDO Pascal spelling/);
});
