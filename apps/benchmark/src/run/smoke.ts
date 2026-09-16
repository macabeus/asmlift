// Smoke check: drive one trivial function through asmlift end-to-end on every available
// toolchain, validating the toolchain adapters + asmlift import path.
import { decompile } from '@asmlift/core/pipeline';
import { isCanonicalToolchainId } from '@asmlift/core/target';

import { benchScorer } from '../decomp-config';
import { availableToolchains, canonicalCodegen } from '../toolchains';

const REF = 'int add(int a, int b){ return a + b; }';
const SYM = 'add';

export function smoke(): void {
  for (const tc of availableToolchains()) {
    // The smoke test compiles ONE fixed reference at the toolchain's canonical flags. A toolchain
    // with none has no flag set of its own to run it at — its rows each bring their build's.
    if (!isCanonicalToolchainId(tc.id)) {
      console.log(`[${tc.id}] no canonical flags — every row of this toolchain names its own`);
      continue;
    }
    try {
      const codegen = canonicalCodegen(tc.id);
      const { obj, asm } = tc.buildTarget(REF, SYM, codegen.cflags);
      const r = decompile(SYM, asm, codegen.target);
      const s = benchScorer(tc.id, codegen.cflags)(r.source, SYM, obj);
      console.log(`[${tc.id}] asmlift → score=${s.score}/${s.rows} match=${s.match}`);
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
