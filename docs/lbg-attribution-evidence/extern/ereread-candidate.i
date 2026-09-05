typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;
extern u32 gReadBgs;
struct Elem0 { s32 field_0; u8 _pad0[4]; };
void ereread(u32 a0, u32 a1) {
    u32 v0;
    for (v0 = 0; v0 < a1; v0 = v0 + 1) {
        ((s32 *)((struct Elem0 *)&gReadBgs)[a0].field_0)[v0] = v0 << 6;
    }
    return;
}

