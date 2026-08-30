// URL-state glue for nuqs: the playground ShareState as a single `s=` param in the fragment (see
// hash-adapter.ts). The codec itself stays in permalink.ts (dependency-free).
import { createParser } from 'nuqs';

import { type ShareState, decodeShare, encodeShare } from './permalink';

export const parseAsShareState = createParser<ShareState>({
  parse: decodeShare,
  serialize: encodeShare,
  eq: (a, b) => a === b || encodeShare(a) === encodeShare(b),
});
