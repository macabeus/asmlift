/* THE RETURN TAIL WRITTEN INTO EVERY ARM: the twin of `probe-rettail-pc-join.c`, with `gV = a; k(a);
 * return;` in each arm that reaches it. Compiled by scripts/regen-rettail-probes.ts. */
extern int gT, gW, gV;
void m(int);
void k(int);
void f(int a, int b, int c) {
    if (a == 0) {
        gT = c;
        gV = a;
        k(a);
        return;
    } else if (a == 1) {
        gW = c;
        gV = a;
        k(a);
        return;
    } else if (a == 2) {
        m(2);
        return;
    }
    gV = a;
    k(a);
}
