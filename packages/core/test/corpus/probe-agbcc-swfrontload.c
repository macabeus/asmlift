/* The `switch` half of agbcc's own switch-vs-ladder spelling pair for
 * `TargetDescription.compilerBehaviors.switchRequiresFrontLoadedTests` (target.ts, ARMV4T_AGBCC).
 *
 * `probe-agbcc-swladder.c` is the SAME two-case body written as an if/else-if ladder. Both are
 * 20 bytes (0x14, ten Thumb instructions) and they are DIFFERENT objects: the `switch` front-loads
 * both tests and sorts them ascending (0x1e before 0x64, the reverse of the written order), the
 * ladder emits each test directly above the body it guards.
 *
 * Compiled by `scripts/regen-switch-spelling-probes.ts`; flags are in the generated fixture's
 * header. Read by `packages/core/test/switch-arms.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-switch-spelling-probes.ts
 */
s32 f(s32 x)
{
    s32 a;
    a = 0;
    switch (x) {
    case 100:
        a = 1;
        break;
    case 30:
        a = 2;
        break;
    }
    return a;
}
