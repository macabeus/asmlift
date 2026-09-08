/* The LADDER half of agbcc's pair — see `probe-agbcc-swfrontload.c`. Identical body, written as an
 * if/else-if ladder instead of a `switch`.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
s32 f(s32 x)
{
    s32 a;
    a = 0;
    if (x == 100) {
        a = 1;
    } else if (x == 30) {
        a = 2;
    }
    return a;
}
