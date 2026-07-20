// URL-state glue for nuqs: the playground ShareState as a single `?s=` query param. The codec
// itself stays in permalink.ts (dependency-free).
import { createParser } from 'nuqs';

import { type ShareState, decodeShare, encodeShare } from './permalink';

// lz-string's URI alphabet includes '+', which URLSearchParams decodes to a space — restore it
// before decoding (a space can never legitimately appear in an lz-string payload).
export const parseAsShareState = createParser<ShareState>({
  parse: (value) => decodeShare(value.replaceAll(' ', '+')),
  serialize: encodeShare,
  eq: (a, b) => a === b || encodeShare(a) === encodeShare(b),
});
