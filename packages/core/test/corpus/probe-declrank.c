int sink(int);
int probe(int n)
{
    int a, b, c, d, e, f, g, h, i, j, k, l, m, o, p, q;
    a = n + 0x11;
    b = n + 0x22;
    c = n + 0x33;
    d = n + 0x44;
    e = n + 0x55;
    f = n + 0x66;
    g = n + 0x77;
    h = n + 0x88;
    i = n + 0x99;
    j = n + 0xaa;
    k = n + 0xbb;
    l = n + 0xcc;
    m = n + 0xdd;
    o = n + 0xee;
    p = n + 0xff;
    q = n + 0x110;
    sink(n);
    return a * b + c * d + e * f + g * h + i * j + k * l + m * o + p * q;
}
