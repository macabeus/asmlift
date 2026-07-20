// Smoke check: drive one trivial function through asmlift end-to-end on every available
// toolchain, validating the toolchain adapters + asmlift import path.
import { decompile } from '@asmlift/core/pipeline';

import { availableToolchains } from '../toolchains';

const REF = 'int add(int a, int b){ return a + b; }';
const SYM = 'add';

export function smoke(): void {
  for (const tc of availableToolchains()) {
    try {
      const { obj, asm } = tc.buildTarget(REF, SYM);
      const r = decompile(SYM, asm, tc.targetDesc);
      const s = tc.score(r.source, SYM, obj);
      console.log(`[${tc.id}] asmlift → score=${s.score} match=${s.match}`);
      console.log(
        r.source
          .trimEnd()
          .split('\n')
          .map((l) => '    ' + l)
          .join('\n'),
      );
    } catch (e) {
      console.log(`[${tc.id}] ERROR: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}
