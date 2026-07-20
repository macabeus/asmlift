// Syntax-highlighted code block — starry-night (the TextMate grammars GitHub uses), colored by the
// global VS Code `.pl-*` palette in index.css. Shared by both pages (the Playground's C/C++/Pascal
// output + IR dumps, and the Benchmark's C/C++/asm source views + bash repro scripts). The highlighter loads once
// (module-level promise); until it resolves the escaped plain text shows, so nothing flashes beyond
// the color pass. `"plain"` skips highlighting entirely (Pascal / IR dumps). The caller owns the
// <pre> chrome via `className`; the base only fixes the scroll/whitespace/mono essentials.
import { createStarryNight } from '@wooorm/starry-night';
import sourceAssembly from '@wooorm/starry-night/source.assembly';
import sourceC from '@wooorm/starry-night/source.c';
import sourceCpp from '@wooorm/starry-night/source.c++';
import sourceShell from '@wooorm/starry-night/source.shell';
import type { Root, RootContent } from 'hast';
import { useEffect, useState } from 'react';

// Only the grammars the app renders (not `common`, which is ~35 grammars of bundle).
const grammars = [sourceC, sourceCpp, sourceAssembly, sourceShell];

export type CodeLanguage = 'c' | 'c++' | 'asm' | 'bash' | 'plain';

const scopeMap: Record<Exclude<CodeLanguage, 'plain'>, string> = {
  c: 'source.c',
  'c++': 'source.c++',
  asm: 'source.assembly',
  bash: 'source.shell',
};

let starryNightPromise: ReturnType<typeof createStarryNight> | null = null;
function getStarryNight() {
  starryNightPromise ??= createStarryNight(grammars);
  return starryNightPromise;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toHtml(node: Root | RootContent): string {
  if (node.type === 'text') {
    return escapeHtml(node.value);
  }
  if (node.type === 'element') {
    const className = Array.isArray(node.properties?.className) ? node.properties.className.join(' ') : '';
    const children = node.children?.map((c) => toHtml(c)).join('') ?? '';
    return `<span class="${className}">${children}</span>`;
  }
  if (node.type === 'root') {
    return node.children?.map((c) => toHtml(c)).join('') ?? '';
  }
  return '';
}

export function CodeBlock({
  code,
  language,
  className = '',
}: {
  code: string;
  language: CodeLanguage;
  className?: string;
}) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (language === 'plain') {
      setHtml('');
      return;
    }
    let cancelled = false;
    getStarryNight().then((sn) => {
      if (!cancelled) {
        setHtml(toHtml(sn.highlight(code, scopeMap[language])));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <pre className={`scroll-slim overflow-auto whitespace-pre font-mono ${className}`}>
      <code dangerouslySetInnerHTML={{ __html: (language !== 'plain' && html) || escapeHtml(code) }} />
    </pre>
  );
}
