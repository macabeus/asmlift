import { decompile } from '../src/pipeline';
import { MIPS_GCC } from '../src/target';
import { returnType } from '../src/raise/recover';

// one exit sets v0, the other never touches it -> operand-less ret on that path
const asm =
  '00000000 <mixed>:\n' +
  '   0:\tbeqz\ta0,14 <mixed+0x14>\n' +
  '   4:\tnop\n' +
  '   8:\tli\tv0,5\n' +
  '   c:\tjr\tra\n' +
  '  10:\tnop\n' +
  '  14:\tjr\tra\n' +
  '  18:\tnop\n';
try {
  console.log(decompile('mixed', asm, MIPS_GCC).source);
} catch (e) {
  console.log('THREW:', (e as Error).message);
}
