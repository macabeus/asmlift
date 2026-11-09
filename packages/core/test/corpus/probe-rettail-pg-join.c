/* THE TAIL WRITTEN ONCE, after an early `return gB` that is the THEN arm of `gB == 0`: the twin of
 * `probe-rettail-pg-copies.c`. The return falls through the branch in the compiler's own jump, so
 * cse folds the `gB` it returns to the 0 the branch proved: the `beqz`'s delay slot is
 * `move v0,zero`, at every level that optimises. Compiled by scripts/regen-rettail-probes.ts. */
extern unsigned char gA;
extern unsigned short gB;
extern unsigned short gC;
void w(int, int);
void v(int);
int f(int *p) {
    if (gA == 0) {
        if (gB == 0) {
            return gB;
        }
    }
    if ((gC & 128) == 0) {
        w(11, 8);
        v(60);
    }
    p[5] = 7;
    return 7;
}
