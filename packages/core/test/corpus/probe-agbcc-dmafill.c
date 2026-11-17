typedef volatile unsigned int vu32;
#define DmaFill32(v, dst, n) { vu32 tmp = (vu32)(v); *(vu32 *)0x040000D4 = (unsigned int)&tmp; ((vu32 *)0x040000D4)[1] = (unsigned int)(dst); ((vu32 *)0x040000D4)[2] = 0x85000000 | (n); ((vu32 *)0x040000D4)[2]; }
extern unsigned char *gP;
extern unsigned char *gQ;
void g(void);
void k(void);
void use(unsigned int *p);
unsigned short h(int x);
void five(int a, int b, int c, int d, int e);
void dcall(void) { unsigned int w; DmaFill32(0, gP, 0x1a); g(); use(&w); }
void dpaths(void) { unsigned short r = h(1); if (r) { DmaFill32(0, gP, 0x1a); g(); } else if (h(0)) { DmaFill32(r, gQ, 0xa); gQ[1] = 1; } k(); }
void dtwo(void) { DmaFill32(0, gP, 0x1a); DmaFill32(0, gQ, 0xa); g(); }
void dfive(int x) { DmaFill32(0, gP, 0x1a); five(1, 2, 3, 4, x); }
