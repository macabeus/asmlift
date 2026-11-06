/* THE RETURN TAIL WRITTEN INTO EVERY CASE of a seven-case `switch`: `p[3] = p[3] + v; return;` per
 * case, with three cases adding 528, two 512 and two 256. Its twin `probe-rettail-pb-join.c` sets `v`
 * per case and writes the tail once. A compiler that cross-jumps return tails
 * (target.ts `crossJumpsReturnTails`) keeps the tail's store ONCE here, but its cross-jump labels
 * leave identical case bodies apart, where the join merges them.
 * Compiled by scripts/regen-rettail-probes.ts. */
void f(int *p, int k) {
    switch (k) {
    case 0: p[3] = p[3] + 256; return;
    case 1: p[3] = p[3] + 512; return;
    case 2: p[3] = p[3] + 528; return;
    case 3: p[3] = p[3] + 528; return;
    case 4: p[3] = p[3] + 528; return;
    case 5: p[3] = p[3] + 512; return;
    case 6: p[3] = p[3] + 256; return;
    }
}
