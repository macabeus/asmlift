// The cli's declare module is a RE-EXPORT of core's renderer (the webapp wasm scorer imports
// core directly) — pin the identity so a fork can never let the two scoring worlds drift.
// The behavior pins live with the implementation: packages/core/test/declare.test.ts.
import { renderDeclarations as coreRender } from '@asmlift/core/declare';
import { expect, test } from 'vitest';

import { renderDeclarations } from '../../src/declare';

test('cli renderDeclarations IS core renderDeclarations (same function object)', () => {
  expect(renderDeclarations).toBe(coreRender);
});
