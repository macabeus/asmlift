int sink(int);
int nine(int a, int b, int c, int d, int e, int f, int g, int h, int i) { return a + b + c + d + e + f + g + h + i; }
int br6(int a, int b, int c, int d, int e, int f) { if (a) return sink(b) + f; return b; }
int kr(a, b, c, d, e) int a, b, c, d, e; { return e - a; }
int call9(int *p) { return nine(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]); }
int call_br(int *p) { return br6(p[0], p[1], p[2], p[3], p[4], p[5]); }
int krmore(int x) { return kr(x + 1, 2, 3, 4, 5, 6); }
int six(int a, int b, int c, int d, int e, int f) { return a + b + c + d + e + f; }
int wide_then_narrow(int *p, int *q) { nine(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]); return six(q[0], q[1], q[2], q[3], q[4], q[5]); }
int wide_on_a_branch(int *q, int x) { if (x) nine(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8]); return six(q[0], q[1], q[2], q[3], q[4], q[5]); }
struct L { long long v; };
int ts(int a, int b, int c, struct L s) { return a + b + c + (int)s.v; }
int callts(int a, struct L *p) { return ts(a, 5, 6, *p); }
int ll4(int a, int b, int c, long long d) { return a + b + c + (int)d; }
int callll(int *p) { return ll4(p[0], p[1], p[2], *(long long *)(p + 4)); }
int t1(int a, long long b, int c) { return a + (int)b + c; }
int callt1(int a, long long *p) { return t1(a, *p, 7); }
int ll4c(int a, int b, int c, long long d) { return sink(a) + (int)d; }
int callllc(int *p) { return ll4c(p[0], p[1], p[2], *(long long *)(p + 4)); }
int g6(int a, int b, int c, int d, int e, int z) { return a + b + c + d + e; }
int f5(int a, int b, int c, int d, int e) { return sink(a + b + c + d + e); }
int f6(int a, int b, int c, int d, int e, int z) { return sink(a + b + c + d + e + z); }
int restaged(int x) { f5(1, 2, 3, 4, x); return f5(5, 6, 7, 8, x); }
int restaged_higher(int x, int y) { f5(1, 2, 3, 4, x); return g6(5, 6, 7, 8, y, x); }
int restaged_same_word(int x, int y, int z) { f6(1, 2, 3, 4, y, x); return g6(5, 6, 7, 8, z, x); }
