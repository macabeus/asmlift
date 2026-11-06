/* THE RETURN TAIL WRITTEN ONCE: the twin of `probe-rettail-pf-copies.c`, every arm falling into one
 * `h(30, v); gArr[v & 15] = a;` after the `if` chain. Compiled by scripts/regen-rettail-probes.ts. */
void h(int, int);
void k(int);
extern int gA, gT;
extern int gArr[16];
void f(int a, int b, int c) {
    int v = b;
    if (b > 4) {
        gT = v;
    } else if (gA != 0) {
        v = v + c;
        k(v);
    } else if (b == c) {
        return;
    } else if (a == 0) {
        gT = v;
    }
    h(30, v);
    gArr[v & 15] = a;
}
