/* AN EARLY RETURN IN AN ELSE ARM, OF THE VALUE ITS BRANCH TESTED AGAINST 0: the twin of
 * `probe-rettail-pg-join.c`, with the tail written into both arms that reach it and `return gB` in
 * the else arm of `gB != 0`. The shape of Mario Party 3's `func_8010BD28_472F98_mgmode`. gcc 2.x's cse
 * records `gB == 0` on the branch's not-taken edge only, below -O2, so here `gB` is returned as
 * loaded: the `beqz`'s delay slot is a `nop`. Compiled by scripts/regen-rettail-probes.ts. */
extern unsigned char gA;
extern unsigned short gB;
extern unsigned short gC;
void w(int, int);
void v(int);
int f(int *p) {
    if (gA == 0) {
        if (gB != 0) {
            if ((gC & 128) == 0) {
                w(11, 8);
                v(60);
            }
            p[5] = 7;
            return 7;
        } else {
            return gB;
        }
    } else {
        if ((gC & 128) == 0) {
            w(11, 8);
            v(60);
        }
        p[5] = 7;
        return 7;
    }
}
