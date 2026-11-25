/* A callee's body that makes a call of its own nothing declares (read by callee-body-nested.test.ts).
 * `mid` stages five stack words for `nine`, which only `nine`'s body sizes; `mid2` hands its one
 * argument to `one`, which reads r0 alone. `stkbody_self` stages its own five stack words for a call
 * to itself, which only its own entry's loads size. `top` wraps `mid` once more, so `stkbody_deep`'s
 * bound rests on bodies three levels down; `cyca` and `cycb` call each other, a cycle the reading
 * must end. */
extern int gv[];
extern int gk[];
void nine(a, b, c, d, e, f, g, h, i) int a, b, c, d, e, f, g, h, i;
{ gv[0] = a + e; gv[1] = b + f; gv[2] = c + g; gv[3] = d + h; gv[4] = i; }
void mid() { nine(gk[0], gk[1], gk[2], gk[3], 0, 1, 0, 0x1f, gk[4]); }
void stkbody_nest(int n) { int i; for (i = 0; i < n; i++) { gv[8 + i] = i; mid(); } }
int one(a) int a; { return gv[a] + 1; }
void mid2(a) int a; { gv[2] = one(a); }
void stkbody_rnest(int *p, int b, int c) { gv[5] = c + 3; mid2(p[0]); }
void stkbody_self(a, b, c, d, e, f, g, h, i) int a, b, c, d, e, f, g, h, i;
{
    gv[0] = a + e; gv[1] = b + f; gv[2] = c + g; gv[3] = d + h; gv[4] = i;
    if (a > 0) stkbody_self(a - 1, b, c, d, e, f, g, h, i + 1);
}
void top() { gv[20] = 3; mid(); }
void stkbody_deep(int n) { int i; for (i = 0; i < n; i++) { gv[8 + i] = i; top(); } }
void cycb();
void cyca(n) int n; { if (n > 0) cycb(n - 1); }
void cycb(n) int n; { gv[6] = n; cyca(n); }
void stkbody_cyc(int *p, int b) { gv[7] = b; cyca(p[0]); }
