// asmlift — the C language backend. Consumes the language-NEUTRAL L3 AST and owns ALL C spelling.
// Text is produced ONLY by a precedence-aware printer over the typed AST — never by string-
// concatenating over IR ops.
//
// Expression/statement/type spelling lives in backend/cfamily.ts, shared with the C++ backend;
// this backend owns only the C SIGNATURE line. The Pascal backend implements the same
// LanguageBackend interface over the same L3 with its OWN spelling.
import { LanguageBackend, SFn } from '../l3/ast';
import { cComment, cDeclare, cType, emitCFamily } from './cfamily';

export { cComment }; // re-export: the shared spelling lives in cfamily.ts

export const cBackend: LanguageBackend = {
  id: 'c',
  spellsSwitchFallthrough: true,
  emit(fn: SFn): string {
    // The SAME declarator placement the local list and the struct-field printer use, so one
    // function cannot spell the `*` on the type in its signature and on the declarator in its
    // body.
    const params = fn.params.map((p) => cDeclare(p.type, p.name)).join(', ') || 'void';
    return emitCFamily(`${cType(fn.retType)} ${fn.name}(${params})`, fn);
  },
  comment: cComment,
};
