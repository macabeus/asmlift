// The variation definitions and the glossary carry markdown code spans, which `ui/InlineCode` renders.
// Where no element can render, in a `title` attribute or an ECharts tooltip, the spans are written
// plainly, through these.
import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import type { VariationName } from '@asmlift/core/variation-tokens';

/** `text` with its code spans' backticks removed, for a `title` attribute. */
export function plainText(text: string): string {
  return text.replace(/`/g, '');
}

/** `text` plain and escaped, for a tooltip, which ECharts renders as HTML. */
export function plainHtml(text: string): string {
  return plainText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A variation tooltip's first line: its title, then its name. */
export function tooltipTitle(name: VariationName): string {
  return `<div style="font-weight:600">${plainHtml(VARIATION_DEFINITIONS[name].title)} <span style="opacity:.6;font-family:monospace">${name}</span></div>`;
}
