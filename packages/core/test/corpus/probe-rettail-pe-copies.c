/* THE RETURN TAIL WRITTEN INTO EVERY ARM, `h(30, v); k(v);`, where agbcc's cross-jump leaves the
 * surviving copy split over two blocks: the twin of `probe-rettail-pe-join.c`. The `m` arm's own
 * `k(v)` enters the tail part-way, so the `h` call falls into the rest of it, and that rest jumps
 * over the `gU = b` arm laid out after it. Compiled by scripts/regen-rettail-probes.ts. */
void h(int, int);
void k(int);
void m(int);
extern int gA, gU;
void f(int a, int b, int c) {
    int v = b;
    if (gA != 0) {
        v = v + a;
        h(30, v);
        k(v);
        return;
    } else if (b == c) {
        v = v + c;
        m(v + 2);
        k(v);
        return;
    } else if (gA != 0) {
        return;
    } else if (c != 0) {
        gU = c;
        h(30, v);
        k(v);
        return;
    } else if (b == c) {
        return;
    }
    gU = b;
    k(v);
}
