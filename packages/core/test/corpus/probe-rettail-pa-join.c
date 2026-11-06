/* THE RETURN TAIL WRITTEN ONCE, after a three-arm `if`: the twin of `probe-rettail-pa-copies.c`.
 * Compiled by scripts/regen-rettail-probes.ts. */
void h(int, int);
void f(int a) {
    int v;
    if (a == 0) v = 10;
    else if (a == 2) v = 20;
    else { h(30, 0); return; }
    h(v, 0);
}
