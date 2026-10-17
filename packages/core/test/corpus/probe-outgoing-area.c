/* Outgoing-area load probe for `TargetDescription.compilerBehaviors.outgoingAreaNeverLoadedFrom` on
 * the O32 and mwcc compilers: which words of its own outgoing argument area a caller LOADS. The
 * area is the frame bottom — on O32 the 16-byte home of a0..a3 and then the stack words a call
 * takes from 16(sp), on PowerPC the callee's parameter area from 8(r1), past the back chain and
 * the link-register save word.
 *
 * Each function is a shape that would load a word of the area if anything did: calls inside stack
 * arguments (`nested`, `cond`, `libdiv`, `nested2`, `pnest`, `pcond`), a by-value aggregate staged
 * around nested calls (`bystruct`, `c1`..`c7`, `d1`..`d6`, `big1`, `big2`, `st5`, `j1`..`j5`), a
 * double or a long long on the stack (`dbl`, `dstk`, `llstk`, `llten`), struct-return temps beside
 * stack-argument calls (`sret1`..`sret3`, `j2`, `j5`), a variadic body and a variadic caller
 * (`vbody`, `vcall`, `c6`), K&R calls (`krs`, `krf`), and spills live across stack-argument calls
 * (`spills`, `pspills`: the positive controls, whose loads exist and land above the area).
 *
 * Compiled by `scripts/regen-outgoing-area-o32-mwcc-probes.ts` on ido7.1, gcc2.7.2kmc and gcc2.7.2
 * at every level their rows build at and at -O0, and on mwcc_242_81, mwcc_247_107 and
 * mwcc_233_163n at the flags their rows use and at -O0,p — flags and objdump command are in each
 * generated `*-outarea.txt` header. Read by `packages/core/test/outgoing-area-probes.test.ts`.
 */
struct S3 { int a, b, c; };
struct S5 { int a, b, c, d, e; };
struct S10 { int a[10]; };
struct S16 { int a[16]; };
struct C7 { char a[7]; };
struct C11 { char a[11]; };
struct S5 mk(int);
struct C7 mk7(int);
int pick(int);
double dpick(int);
int five(int a, int b, int c, int d, int e);
int six(int a, int b, int c, int d, int e, int f);
int nine(int a, int b, int c, int d, int e, int f, int g, int h, int i);
int ten(int a, int b, int c, int d, int e, int f, int g, int h, int i, int j);
int takes(int a, int b, int c, int d, struct S5 s);
int dsix(double a, double b, int c, int d);
int ps(int a, struct S5 s);
int ps2(int a, struct S5 s, int b);
int ps3(int a, int b, struct S3 s, int c);
int dd(int a, double d, int b, int c);
int vf(int a, ...);
int pc7(int a, int b, struct C7 s, int c);
int pc11(int a, struct C11 s, int c);
int fd(int a, int b, int c, int d, double e);
int fll(int a, int b, int c, int d, long long e, int f);
int tenll(int a, int b, int c, int d, int e, int f, int g, int h, long long i, int j);
int pb(int a, struct S10 s);
int pb5(int a, int b, int c, struct S5 s);
int pbv(struct S5 s);
int pbig(int a, struct S16 s, int b);
int tenS(int a, int b, int c, int d, int e, int f, int g, int h, struct S5 s, int j);
int kr();
#ifdef __MWERKS__
typedef struct __va_list_struct { char gpr; char fpr; char reserved[2]; char *input_arg_area; char *reg_save_area; } va_list[1];
#define va_start(ap, fmt) ((void)fmt, __builtin_va_info(&ap))
#else
typedef char *va_list;
#define va_start(ap, n) (ap = (char *)&n + sizeof(n))
#endif
int vten(int a, int b, int c, int d, int e, int f, int g, int h, va_list ap, int j);

int nested(int x, int y) { return six(x, y, 3, 4, five(y, x, 3, 4, x * y), x - y); }
int cond(int x, int y, int z) { return six(1, 2, 3, z, x ? pick(y) : y, y / z); }
int libdiv(long long x, long long y) { return six(1, 2, 3, 4, (int)(x / y), (int)(x % y)); }
int nested2(int x, int y) { return six(1, 2, 3, 4, six(1, 2, 3, 4, x, y), six(4, 3, 2, 1, y, x)); }
int bystruct(struct S5 *p, int x) { return takes(1, 2, 3, x, *p); }
int dbl(double a, int x) { return dsix(a, a * 2.0, x, pick(x)); }
int pnest(int x, int y) { return ten(1, 2, 3, 4, 5, 6, 7, 8, nine(1, 2, 3, 4, 5, 6, 7, 8, x), ten(1, 2, 3, 4, 5, 6, 7, 8, y, x)); }
int pcond(int x, int y) { return ten(1, 2, 3, 4, 5, 6, 7, 8, x ? pick(y) : y, y / x); }
int spills(int *p, int n) {
  int a = p[0], b = p[1], c = p[2], d = p[3], e = p[4], f = p[5], g = p[6], h = p[7], i = p[8], s = 0;
  while (n-- > 0) {
    s += six(a, b, c, d, e * s, f) + six(g, h, i, a * b, c * d, s);
  }
  return s + a + b + c + d + e + f + g + h + i;
}
int pspills(int *p, int n) {
  int a = p[0], b = p[1], c = p[2], d = p[3], e = p[4], f = p[5], g = p[6], h = p[7], i = p[8], s = 0;
  while (n-- > 0) {
    s += ten(a, b, c, d, e * s, f, g, h, i, s) + ten(g, h, i, a * b, c * d, s, a, b, c, d);
  }
  return s + a + b + c + d + e + f + g + h + i;
}
int c1(int x, struct S5 *p) { return ps(x, *p); }
int c2(int x, struct S5 *p) { return ps(pick(x), *p); }
int c3(int x, int y, struct S5 *p) { return ps2(x, *p, pick(y)); }
int c4(int x, int y, struct S3 *p) { return ps3(x, pick(y), *p, pick(x)); }
int c5(int x, int y, int z) { return dd(x, dpick(y), pick(y), z); }
int c6(int x, int y, int z) { return vf(x, 1.0, pick(y), z, dpick(x)); }
int c7(int x, struct S3 *p, struct S3 *q) { return ps3(x, ps3(x, 1, *q, 2), *p, pick(x)); }
int d1(int x, int y) { return ps(x, mk(y)); }
int d2(int x, int y, int z) { return ps2(x, mk(y), pick(z)); }
int d3(int x, struct C7 *p) { return pc7(x, pick(x), *p, pick(x + 1)); }
int d4(int x, int y) { return pc7(x, y, mk7(y), pick(x)); }
int d5(int x, struct C11 *p) { return pc11(pick(x), *p, pick(x + 1)); }
int d6(int x, int y) { return ps2(pick(x), mk(y), ps2(x, mk(x), y)); }
int dstk(int x, int y) { return fd(x, 1, 2, pick(x), (double)y * 2.0); }
int llstk(long long a, long long b) { return fll(1, 2, 3, 4, a / b, pick(1)); }
int llten(long long a, long long b) { return tenll(1, 2, 3, 4, 5, 6, 7, 8, a % b, pick(2)); }
int big1(int x, struct S10 *p) { return pb(x, *p); }
int big2(int x, struct S10 *p) { return pb(pick(x), *p); }
int st5(int x, struct S5 *p) { return pb5(x, pick(x), x, *p); }
int sret1(int x) {
  struct S5 t = mk(x);
  return six(t.a, t.b, t.c, t.d, t.e, x) + ten(1, 2, 3, 4, 5, 6, 7, 8, t.a, t.e);
}
int sret2(int x, int y) { return pb5(x, y, pick(x), mk(y)); }
struct S5 sret3(int x) {
  struct S5 s;
  s.a = six(x, 1, 2, 3, 4, 5);
  s.b = ten(x, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  s.c = x;
  s.d = s.a + s.b;
  s.e = 0;
  return s;
}
int vbody(int n, ...) {
  va_list ap;
  int r;
  va_start(ap, n);
  r = vten(1, 2, 3, 4, 5, 6, 7, n, ap, pick(n));
  return r + six(n, 1, 2, 3, 4, pick(r));
}
int vcall(int x, int y) { return vf(x, 1, 2, 3, 4, 5, 6, 7, 8, 2.5, pick(y), y); }
int krs(struct S5 *p, int x) { return kr(1, 2, 3, 4, 5, 6, 7, x, *p, pick(x)); }
int krf(float f, int x) { return kr(x, f, x, f, pick(x)); }
int j1(struct S5 *p, int x) { return ten(1, 2, 3, 4, 5, 6, 7, 8, x, pick(x)) + pbv(*p); }
int j2(int x) { return ten(1, 2, 3, 4, 5, 6, 7, 8, x, 2) + pbv(mk(x)); }
int j3(struct S16 *p, int x) { return pbig(x, *p, pick(x)); }
int j4(struct S5 *p, int x) { return tenS(1, 2, 3, 4, 5, 6, 7, x, *p, pick(x)); }
int j5(int x) { return tenS(1, 2, 3, 4, 5, 6, 7, x, mk(x), ten(1, 2, 3, 4, 5, 6, 7, 8, x, pick(x))); }
