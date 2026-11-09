/* THE RETURN TAIL WRITTEN INTO EVERY ARM, in a three-arm `if`: `h(v, 0); return;` per arm, with the
 * last arm's copy falling into the function's end. Its twin `probe-rettail-pa-join.c` writes the tail
 * once, after the `if`. A compiler that cross-jumps return tails (target.ts `crossJumpsReturnTails`)
 * keeps one copy of the two jumping arms' tails and leaves the else arm laid out after it.
 * Compiled by scripts/regen-rettail-probes.ts. */
void h(int, int);
void f(int a) {
    if (a == 0) { h(10, 0); return; }
    else if (a == 2) { h(20, 0); return; }
    else { h(30, 0); }
}
