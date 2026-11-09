/* THE RETURN TAIL WRITTEN ONCE, after an `if` whose first two arms store one register to two
 * DIFFERENT globals: the twin of `probe-rettail-pc-copies.c`. In a relocatable object the two
 * stores' instructions read the same (MIPS: `lui at,0x0` / `sw a2,0(at)`); only the relocation
 * names the global. Compiled by scripts/regen-rettail-probes.ts. */
extern int gT, gW, gV;
void m(int);
void k(int);
void f(int a, int b, int c) {
    if (a == 0) {
        gT = c;
    } else if (a == 1) {
        gW = c;
    } else if (a == 2) {
        m(2);
        return;
    }
    gV = a;
    k(a);
}
