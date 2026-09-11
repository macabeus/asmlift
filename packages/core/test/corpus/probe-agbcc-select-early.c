/* The EARLY-RETURN spelling of the same four functions as probe-agbcc-select-merge.c. */
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
int selbody(int x, int *p) {
    if (x) { *p = 1; return 5; }
    *p = 2;
    return 3;
}
