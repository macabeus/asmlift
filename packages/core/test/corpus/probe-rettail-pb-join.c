/* THE RETURN TAIL WRITTEN ONCE, after a seven-case `switch`: the twin of `probe-rettail-pb-copies.c`.
 * Compiled by scripts/regen-rettail-probes.ts. */
void f(int *p, int k) {
    int v;
    switch (k) {
    case 0: v = 256; break;
    case 1: v = 512; break;
    case 2: v = 528; break;
    case 3: v = 528; break;
    case 4: v = 528; break;
    case 5: v = 512; break;
    case 6: v = 256; break;
    default: return;
    }
    p[3] = p[3] + v;
}
