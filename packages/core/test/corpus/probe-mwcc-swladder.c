/* The equality LADDER of the mwcc fixtures — see `probe-mwcc-swdispatch.c` for what they are for.
 * Identical body, written as an if/else-if ladder instead of a `switch`.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
int swpath(int x, int *p)
{
    if (x == 0) {
        return p[0];
    } else if (x == 1) {
        return p[1];
    }
    return p[2];
}
