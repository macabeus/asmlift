import { decompile } from '../src/pipeline';
import { MIPS_GCC } from '../src/target';
// the OPERAND-LESS ret comes FIRST in block order; the valued one second
const asm =
  '00000000 <mixed>:\n' +
  '   0:\tbnez\ta0,14 <mixed+0x14>\n' +
  '   4:\tnop\n' +
  '   8:\tjr\tra\n' +
  '   c:\tnop\n' +
  '  14:\tli\tv0,5\n' +
  '  18:\tjr\tra\n' +
  '  1c:\tnop\n';
try { console.log(decompile('mixed', asm, MIPS_GCC).source); } catch (e) { console.log('THREW:', (e as Error).message); }
