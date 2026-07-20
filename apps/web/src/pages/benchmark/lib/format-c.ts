// Pretty-print a ONE-LINE C/C++ reference source for display. The synthetic dataset authors its
// references as single lines (`int add(int a,int b){ return a+b; }`); real-tier sources arrive
// already formatted and pass through untouched. This is a display-only re-indentation — brace and
// statement line breaks with paren/string awareness — NOT a compiler-grade formatter; anything it
// can't confidently split stays on its line, never altered semantically (whitespace only).

const INDENT = '    ';

/** Already formatted (real-tier) sources pass through; single-line bodies get re-indented. */
export function formatC(src: string): string {
  const trimmed = src.trim();
  // Multi-line already: someone formatted it — don't second-guess.
  if (trimmed.includes('\n')) {
    return src;
  }
  return reindent(trimmed);
}

function reindent(line: string): string {
  const out: string[] = [];
  let cur = '';
  let depth = 0; // brace depth
  let paren = 0; // paren depth — a `;` inside `for (...)` must not break
  let inStr: '"' | "'" | null = null;

  const push = () => {
    if (cur.trim()) {
      out.push(INDENT.repeat(depth) + cur.trim());
    }
    cur = '';
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') {
        cur += line[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      paren++;
      cur += ch;
      continue;
    }
    if (ch === ')') {
      paren--;
      cur += ch;
      continue;
    }
    if (ch === '{') {
      cur += ' {';
      push();
      depth++;
      continue;
    }
    if (ch === '}') {
      push();
      depth = Math.max(0, depth - 1);
      cur = '}';
      // `} else`, `} while (...)` stay glued to the brace
      const rest = line.slice(i + 1).trimStart();
      if (!/^(else\b|while\b)/.test(rest)) {
        push();
      }
      continue;
    }
    if (ch === ';' && paren === 0) {
      cur += ';';
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return (
    out
      .join('\n')
      .replace(/[ \t]+\{/g, ' {')
      .replace(/\n{2,}/g, '\n') + '\n'
  );
}
