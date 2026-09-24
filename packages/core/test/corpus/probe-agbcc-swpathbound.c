/* agbcc's balanced-tree dispatch pinning a case by its PATH, for
 * `TargetDescription.compilerBehaviors.switchBoundCase` (target.ts, ARMV4T_AGBCC).
 *
 * `emit_case_nodes` tests `case 3` with no equality of its own: `cmp r1, #2; bgt` jumps to its body
 * once the tests above have left `x < 4` and `x != 2`, so the branch admits 3 alone. 3 sits at no
 * end of the 32-bit domain, and the jump is the test's BRANCH, never its fall-through.
 *
 * Compiled by `scripts/regen-switch-spelling-probes.ts`; flags are in the generated fixture's
 * header. Read by `packages/core/test/switch-arms.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-switch-spelling-probes.ts
 */
s32 h(s32 x)
{
    switch (x) {
    case 1:
        return 10;
    case 2:
        return 20;
    case 3:
        return 30;
    case 4:
        return 40;
    case 5:
        return 50;
    case 1000:
        return 60;
    case 2000:
        return 70;
    default:
        return -1;
    }
}
