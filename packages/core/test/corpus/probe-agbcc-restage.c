int five(int a, int b, int c, int d, int e);
void use(int *);
int twice(int x, int y) { return five(1, 2, 3, 4, x * y) + five(1, 2, 3, 4, x * y); }
int owns(int a, int b, int c, int d, int e) { e += a; use(&e); return e; }
