extern unsigned char *gp;
void A(int);
void B(int);
void f(int c) { if (c) A(*gp); else B(*gp); }
