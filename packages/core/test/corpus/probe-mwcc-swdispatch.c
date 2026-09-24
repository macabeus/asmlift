/* The `switch` half of the mwcc spelling fixtures for
 * `TargetDescription.compilerBehaviors.switchBoundCase` (target.ts, PPC_MWCC).
 *
 * CodeWarrior dispatches this with one `cmpwi` read by a `beq` and then by a `bge` on its
 * fall-through, and pins `case 0` with a bound test (`x >= 0`) that admits one value only because
 * of the tests above it. `probe-mwcc-swladder.c` is the same body as an if/else-if ladder, and
 * `probe-mwcc-swrelladder.c` the ladder written with the relational tests themselves; the claim
 * the three commit is that they are three different objects, and that only the `switch` carries a
 * path-bound relational test that no body separates from the dispatch.
 *
 * Compiled by `scripts/regen-switch-spelling-probes.ts` for mwcc_242_81 at its canonical flags —
 * the flags and objdump command are in each generated fixture's header. Read by
 * `packages/core/test/switch-arms.test.ts`, and re-compiled on every CodeWarrior build by
 * `packages/cli/test/matching/ppc-compiler-behaviors.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-switch-spelling-probes.ts
 */
int swpath(int x, int *p)
{
    switch (x) {
    case 0:
        return p[0];
    case 1:
        return p[1];
    default:
        return p[2];
    }
}
