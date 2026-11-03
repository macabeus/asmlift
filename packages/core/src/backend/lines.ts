/** `out.push(...lines)` without the spread: a spread passes every line as an ARGUMENT, and V8 throws
 *  "Maximum call stack size exceeded" past about 120k of them (120,000 print, 130,000 throw, node
 *  24). A structuring with a long arm reaches that at a nesting depth of a few dozen, so the throw
 *  reads as deep recursion when it is only size. Every printer appends a child's lines with this,
 *  so the limit binds no backend (the C family and Pascal alike). */
export function append(out: string[], lines: readonly string[]): void {
  for (const line of lines) {
    out.push(line);
  }
}
