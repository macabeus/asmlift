/* A NESTED relational if-ladder for the mwcc fixtures — see `probe-mwcc-swdispatch.c` for what they
 * are for. Its tests pin `x == 4` and `x == 3` by their paths exactly as the `switch` dispatch's do,
 * and its two misses share one `return 0`, so read by the path alone it is
 * `switch (x) { case 3: … case 4: … default: return 0; }`. It is not that object: mwcc lays a body
 * between two of its tests, which is what `switchRequiresFrontLoadedTests` reads.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
int swpath(int x, int *p)
{
    if (x >= 4) {
        if (x < 5) {
            return p[4];
        }
    } else if (x >= 3) {
        return p[3];
    }
    return 0;
}
