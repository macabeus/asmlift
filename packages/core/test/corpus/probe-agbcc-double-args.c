void g(double);
void f4(int a, int b, int c, double d);
void f5(int a, int b, int c, int d, double e);
void f6(int a, int b, int c, int d, int e, double f);
void l4(int a, int b, int c, long long d);
void l5(int a, int b, int c, int d, long long e);
void l6(int a, int b, int c, int d, int e, long long f);
void dreg(void) { g(1.5); }
void dsplit(int a, int b) { f4(a, b, 7, 1.5); }
void dstack(int a, int b) { f5(a, b, a + b, a - b, 1.5); }
void dgap(int a, int b) { f6(a, b, 1, 2, 3, -2.75); }
void dtiny(void) { g(5e-324); }
void dtenth(void) { g(0.1); }
void dtwo(void) { g(2.0); }
void dnegzero(void) { g(-0.0); }
void dpass(double x) { g(x); }
void dmove(int a, double x) { f4(a, a, a, x); }
void dsum(double x, double y) { g(x + y); }
double dlit(double x) { return x + 0.1; }
void dmem(double *p) { g(*p); }
void dkeep(int a, int b, int c, double x) { f4(a, b, c, x); }
void lsplit(int a, int b) { l4(a, b, 7, 0x1122334455667788LL); }
void lstack(int a, int b) { l5(a, b, a + b, a - b, 0x1122334455667788LL); }
void lgap(int a, int b) { l6(a, b, 1, 2, 3, 0x1122334455667788LL); }
void lmove(int a, long long x) { l4(a, a, a, x); }
void lmove5(long long x, int a) { l5(a, a, a, a, x); }
void dmove5(double x, int a) { f5(a, a, a, a, x); }
