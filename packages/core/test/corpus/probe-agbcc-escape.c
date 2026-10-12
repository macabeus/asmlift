struct S { int a; int b; unsigned char c; unsigned short d; };
struct H { int a[17]; };
int g(struct S *);
int gy(int);
int h5(int, int, int, int, int);
int th(struct H);
int tg(int, int, int, int, int, struct H);
int tt3(int, int, int, int, struct H, int, struct H);
int f0(int x, int y) { struct S s; s.a = 0; s.b = x; s.c = 0; s.d = y; return g(&s); }
int f1(int x, int y) { struct S s; s.a = 0; s.b = x; s.c = 0; s.d = y; g(&s); return h5(1, 2, 3, 4, x); }
void qh5(struct H *p, int x) { th(*p); h5(1, 2, 3, 4, x); }
void a2(struct H *p, int y) { tg(1, 2, 3, 4, gy(y), *p); }
void a3(struct H *p, int x, struct H *q) { tt3(1, 2, 3, 4, *p, x, *q); }
