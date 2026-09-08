/* The LADDER half of the pair — see `probe-swfrontload.c` for what the pair is for. Identical
 * body, written as an if/else-if ladder instead of a `switch`.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
void swpick(int x, int *p)
{
    if (x == 6) {
        p[0] = 1;
    } else if (x == 7) {
        p[1] = 2;
    }
}
