int five(int a, int b, int c, int d, int e);
void use(int *);
int twice(int x, int y) { return five(1, 2, 3, 4, x * y) + five(1, 2, 3, 4, x * y); }
int owns(int a, int b, int c, int d, int e) { e += a; use(&e); return e; }
int six(int a, int b, int c, int d, int e, int f);
int pick(int);
int libcalls(int x, int y) { return six(1, 2, 3, 4, x / y, x % y); }
int nested(int x, int y) { return six(x, y, 3, 4, five(y, x, 3, 4, x * y), x - y); }
int cond(int x, int y, int z) { return six(1, 2, 3, z, x ? pick(y) : y, y / z); }
int spills(int *p, int n) {
  int a = p[0], b = p[1], c = p[2], d = p[3], e = p[4], f = p[5], g = p[6], h = p[7], i = p[8], s = 0;
  while (n-- > 0) {
    s += six(a, b, c, d, e * s, f) + six(g, h, i, a * b, c * d, s);
  }
  return s + a + b + c + d + e + f + g + h + i;
}
