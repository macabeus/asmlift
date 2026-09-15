typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;
extern u16 gTable[8];
int gcd(int a,int b){ while(b){int t=b;b=a%b;a=t;} return a; }
int pick(int x){ switch(x){ case 0: return gTable[1]; case 1: return gTable[2]; case 2: return 7; case 3: return 9; default: return -1; } }
