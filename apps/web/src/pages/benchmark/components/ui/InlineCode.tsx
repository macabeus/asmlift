// Prose that carries markdown code spans — the variation definitions and the glossary are written
// that way, because `docs/vocabulary.md` is held to them text for text. Only the span is rendered:
// the strings use no other markdown, and a backtick must never reach the reader. A span never wraps
// inside itself: a name such as `raw-globals` would otherwise break at its hyphen.
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((piece, i) =>
        i % 2 === 1 ? (
          <code key={i} className="whitespace-nowrap rounded bg-slate-800 px-1 font-mono text-[0.9em] text-slate-200">
            {piece}
          </code>
        ) : (
          piece
        ),
      )}
    </>
  );
}
