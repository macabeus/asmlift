extern int gv[];
void use(int *);
int sink(int);
void nine(int a, int b, int c, int d, int e, int f, int g, int h, int i) {
  gv[0] = a + e; gv[1] = b + f; gv[2] = c + g; gv[3] = d + h; gv[4] = i;
}
void narrow9(unsigned char a, unsigned short b, unsigned short c, unsigned short d, unsigned char e,
             unsigned char f, unsigned char g, unsigned char h, unsigned char i) {
  int buf[20];
  buf[a] = b + e; buf[f] = c + g; buf[h] = d + i;
  use(buf);
}
int fifth(int a, int b, int c, int d, int e) { return e + a; }
int seventh(int a, int b, int c, int d, int e, int f, int g) { return g; }
int owns(int a, int b, int c, int d, int e) { e += a; use(&e); return e; }
int kr(a, b, c, d, e) int a, b, c, d, e; { return e - a; }
void call9(int *p) { nine(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]); }
void loop9(int *p, int n) {
  while (n-- > 0) {
    nine(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
    p += 9;
  }
}
int krmore(int x) { return kr(x, 2, 3, 4, 5, 6); }
int krfewer(int x) { return kr(x, 2, 3, 4); }
int calls5(int x, int y) { return fifth(1, 2, 3, x, y) + sink(x); }
