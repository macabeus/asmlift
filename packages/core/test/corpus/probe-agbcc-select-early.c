/* The EARLY-RETURN spelling of the same seven functions as probe-agbcc-select-merge.c. */
int selbtn(int x) {
    if (x & 0x40) { return 1; }
    return 0;
}
int selk53(int x) {
    if (x) { return 5; }
    return 3;
}
int selpool(int x) {
    if (x) { return 0x12345678; }
    return 0x7ABCDEF0;
}
int selcomp(int x, int a, int b) {
    if (x) { return a + b; }
    return a - b;
}
int selbody(int x, int *p) {
    if (x) { *p = 1; return 5; }
    *p = 2;
    return 3;
}
int selcomp3(int x, int a, int b) {
    if (x) { return a + b + 7; }
    return a - b - 7;
}
int selload(int x, int *p, int *q) {
    if (x) { return *p; }
    return *q;
}
