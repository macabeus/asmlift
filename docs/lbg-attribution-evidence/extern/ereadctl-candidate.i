typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;
extern u32 gReadBgs;
struct Elem0 { void *field_0; u8 _pad0[4]; };
void ereadctl(s32 a0, s32 a1) {
    u32 v0;
    s32 * v1;
    v0 = 0;
    if (v0 < a1) {
        v1 = (s32 *)(s32)((struct Elem0 *)&gReadBgs)[a0].field_0;
        do {
            *v1 = v0 << 6;
            v1 = v1 + 1;
            v0 = v0 + 1;
        } while (v0 < a1);
    }
    return;
}

