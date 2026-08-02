import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';
const asm = '0 <mixed>:\n0:\tcmpwi   r3,0\n4:\tbeq     10 <mixed+0x10>\n8:\tli      r3,5\nc:\tblr\n10:\tblr\n';
console.log(decompile('mixed', asm, PPC_MWCC).source);
