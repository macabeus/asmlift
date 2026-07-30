// asmlift cli — declaration synthesis re-export. The renderer itself lives in @asmlift/core
// (core/src/declare.ts — browser-pure) so the webapp's wasm scorer prepends the SAME
// declarations the cli's Node/objdiff scorer does; this module only preserves the cli's
// historical import path. No behavior of its own — the A/B matching suite
// (test/matching/self-declared-ab.test.ts) pins the compiled bytes either way.
export { renderDeclarations } from '@asmlift/core/declare';
