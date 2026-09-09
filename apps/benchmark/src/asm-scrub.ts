// One rule, three callers: the objdump header line an asm dump starts with names the object's
// ABSOLUTE path — a per-machine mkdtemp scratch dir or a cache dir — and every consumer of that
// text wants it byte-stable across machines and cache generations. Published rows, the
// reproduction scripts, m2c's cache keys and `bench fan`'s re-entry into the ranked call all read
// the SAME disassembly, so a fourth spelling of the regex is a way for one of them to read a
// different one.
/** Replace the leading `/abs/path/to/x.o:` header with `target.o:`. Nothing parses that line — the
 *  m2c normalizer and `--asm-data` read the tables below it — so this is a stability edit and never
 *  a semantic one. Idempotent, and a no-op on text that has no such header. */
export function scrubObjectHeader(asm: string): string {
  return asm.replace(/^\/\S+\.o:/m, 'target.o:');
}
