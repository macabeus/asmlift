/* THE RETURN TAIL WRITTEN ONCE: the twin of `probe-rettail-pe-copies.c`, each arm falling into one
 * `k(v)` after the `if` chain. Compiled by scripts/regen-rettail-probes.ts. */
void h(int, int);
void k(int);
void m(int);
extern int gA, gU;
void f(int a, int b, int c) {
    int v = b;
    if (gA != 0) {
        v = v + a;
        h(30, v);
    } else if (b == c) {
        v = v + c;
        m(v + 2);
    } else if (gA != 0) {
        return;
    } else if (c != 0) {
        gU = c;
        h(30, v);
    } else if (b == c) {
        return;
    } else {
        gU = b;
    }
    k(v);
}
