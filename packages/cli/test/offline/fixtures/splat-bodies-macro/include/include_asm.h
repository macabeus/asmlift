#define INCLUDE_ASM(DIR, NAME) asm(".include \"" DIR "/" #NAME ".s\"\n")
asm(".include \"include/macros.s\"\n");
