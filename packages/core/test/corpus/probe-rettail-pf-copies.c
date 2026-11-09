/* THE RETURN TAIL WRITTEN INTO EVERY ARM, `h(30, v); gArr[v & 15] = a;`, where agbcc's cross-jump
 * cuts the `h` call from its argument setup: the twin of `probe-rettail-pf-join.c`. The `gT = v`
 * arm finds `v` in `h`'s second argument register already, so it sets only the first, and the merge
 * stops just above the call, leaving `mov r0, #0x1e` in each arm. Compiled by
 * scripts/regen-rettail-probes.ts. */
void h(int, int);
void k(int);
extern int gA, gT;
extern int gArr[16];
void f(int a, int b, int c) {
    int v = b;
    if (b > 4) {
        gT = v;
        h(30, v);
        gArr[v & 15] = a;
        return;
    }
    if (gA != 0) {
        v = v + c;
        k(v);
        h(30, v);
        gArr[v & 15] = a;
        return;
    }
    if (b == c) {
        return;
    }
    if (a == 0) {
        gT = v;
    }
    h(30, v);
    gArr[v & 15] = a;
}
