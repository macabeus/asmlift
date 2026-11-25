/* A callee's body that makes a call of its own nothing declares (read by callee-body-nested.test.ts).
 * `mid` stages five stack words for `nine`, which only `nine`'s body sizes; `mid2` hands its one
 * argument to `one`, which reads r0 alone. */
extern int gv[];
extern int gk[];
void nine(a, b, c, d, e, f, g, h, i) int a, b, c, d, e, f, g, h, i;
{ gv[0] = a + e; gv[1] = b + f; gv[2] = c + g; gv[3] = d + h; gv[4] = i; }
void mid() { nine(gk[0], gk[1], gk[2], gk[3], 0, 1, 0, 0x1f, gk[4]); }
void stkbody_nest(int n) { int i; for (i = 0; i < n; i++) { gv[8 + i] = i; mid(); } }
int one(a) int a; { return gv[a] + 1; }
void mid2(a) int a; { gv[2] = one(a); }
void stkbody_rnest(int *p, int b, int c) { gv[5] = c + 3; mid2(p[0]); }
