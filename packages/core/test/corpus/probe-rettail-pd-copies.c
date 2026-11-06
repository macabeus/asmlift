/* THE RETURN TAIL WRITTEN INTO EVERY ARM: the twin of `probe-rettail-pd-join.c`, with `g(5); return;`
 * in each arm that reaches it. Compiled by scripts/regen-rettail-probes.ts. */
void g(int);
void f(int x, int y) {
    if (x) {
        if (y == 1) {
            g(2);
            g(5);
            return;
        } else if (y == 2) {
            return;
        } else {
            g(2);
            g(5);
            return;
        }
    }
    g(5);
}
