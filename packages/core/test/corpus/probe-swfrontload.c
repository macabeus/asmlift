/* The `switch` half of the switch-vs-ladder spelling pair for
 * `TargetDescription.compilerBehaviors.switchRequiresFrontLoadedTests` (target.ts, MIPS_GCC).
 *
 * `probe-swladder.c` is the SAME two-case body written as an if/else-if ladder. The claim the pair
 * commits is that the two spellings are different OBJECTS and that the layout says which is which:
 * the `switch` puts every test ahead of every arm body, the ladder puts each test directly above
 * the store it guards. The arms store through a pointer so each body is a `sw` the test can find.
 *
 * Compiled by `scripts/regen-switch-spelling-probes.ts` for gcc2.7.2kmc (-O2) and gcc2.7.2 (-O1) —
 * flags and objdump command are in each generated fixture's header, taken from
 * `@asmlift/toolchains` rather than retyped. Read by `packages/core/test/switch-arms.test.ts`.
 * Regenerate with:
 *
 *   npx tsx scripts/regen-switch-spelling-probes.ts
 */
void swpick(int x, int *p)
{
    switch (x) {
    case 6:
        p[0] = 1;
        break;
    case 7:
        p[1] = 2;
        break;
    }
}
