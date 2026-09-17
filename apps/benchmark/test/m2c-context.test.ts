// The context m2c reads (compile/real.ts `m2cContext`). A host cpp's GNU C reaches m2c as it is; CodeWarrior's
// own preprocessor keeps its dialect, and the Dolphin SDK's inline `asm { … }` blocks make m2c refuse the whole
// context — so m2c gets that context's declarations, which is all its reader takes from any context.
import { describe, expect, test } from 'vitest';

import { declarationsOnly } from '../src/compile/declarations';
import { m2cContext } from '../src/compile/real';

// Shaped like dolphin/os/OSFastCast.h after mwcceppc -EP, around the declarations m2c does read.
const CODEWARRIOR = `typedef struct { int a; char *s; } Rec;
static inline void OSInitFastCast(void) {
asm {li r3, 0x0004
mtspr GQR2, r3
}
}
static Rec tbl[2] = { { 1, "}{" }, { 2, "x" } };
extern int (*hook)(int);
int f(int a)
{
    if (a) { return '}'; }
    return 0;
}
struct s { int b; };
#pragma once
`;

describe('declarationsOnly', () => {
  test('every function body becomes `;`, and nothing else moves', () => {
    expect(declarationsOnly(CODEWARRIOR)).toBe(`typedef struct { int a; char *s; } Rec;
static inline void OSInitFastCast(void);
static Rec tbl[2] = { { 1, "}{" }, { 2, "x" } };
extern int (*hook)(int);
int f(int a);
struct s { int b; };
#pragma once
`);
  });

  test('a text with no function body is returned as it is', () => {
    const decls = 'typedef int s32;\nextern s32 g(void);\nstatic s32 t[] = { 1, 2 };\n';
    expect(declarationsOnly(decls)).toBe(decls);
  });
});

describe('m2cContext', () => {
  test("CodeWarrior's preprocessed context reaches m2c as its declarations", () => {
    expect(m2cContext('mwcc_247_107', CODEWARRIOR)).toBe(declarationsOnly(CODEWARRIOR));
    expect(m2cContext('mwcc_242_81', CODEWARRIOR)).not.toMatch(/asm \{/);
  });

  test("a host preprocessor's context reaches m2c as it is", () => {
    expect(m2cContext('agbcc', CODEWARRIOR)).toBe(CODEWARRIOR);
    expect(m2cContext('ido7.1', CODEWARRIOR)).toBe(CODEWARRIOR);
  });
});
