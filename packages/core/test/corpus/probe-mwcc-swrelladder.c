/* The RELATIONAL ladder of the mwcc fixtures — see `probe-mwcc-swdispatch.c` for what they are
 * for. The same body, written with the very tests the `switch` dispatch emits (`x == 1`, `x >= 1`,
 * `x >= 0`), in the same order.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
int swpath(int x, int *p)
{
    if (x == 1) {
        return p[1];
    }
    if (x >= 1) {
        return p[2];
    }
    if (x >= 0) {
        return p[0];
    }
    return p[2];
}
