/* THE RETURN TAIL WRITTEN ONCE, after an `if` nest whose two `g(2)` arms are identical: the twin of
 * `probe-rettail-pd-copies.c`. agbcc keeps the two arms apart, the first jumping to the tail and the
 * second falling into it, so identical arms that do not both jump are no mark of the copies.
 * Compiled by scripts/regen-rettail-probes.ts. */
void g(int);
void f(int x, int y) {
    if (x) {
        if (y == 1) {
            g(2);
        } else if (y == 2) {
            return;
        } else {
            g(2);
        }
    }
    g(5);
}
