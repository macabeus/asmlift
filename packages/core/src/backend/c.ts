// asmlift — the C language backend. Consumes the language-NEUTRAL L3 AST and owns ALL C spelling.
// Text is produced ONLY by a precedence-aware printer over the typed AST — never by string-
// concatenating over IR ops.
//
// Expression/statement/type spelling lives in backend/cfamily.ts, shared with the C++ backend;
// this backend owns only the C SIGNATURE line. The Pascal backend implements the same
// LanguageBackend interface over the same L3 with its OWN spelling.
import { LanguageBackend, SFn } from '../l3/ast';
import { cComment, cType, emitCFamily } from './cfamily';

export { cComment }; // re-export: the shared spelling lives in cfamily.ts

export const cBackend: LanguageBackend = {
  id: 'c',
  emit(fn: SFn): string {
    const params = fn.params.map((p) => `${cType(p.type)} ${p.name}`).join(', ') || 'void';
    return emitCFamily(`${cType(fn.retType)} ${fn.name}(${params})`, fn);
  },
  comment: cComment,
};
