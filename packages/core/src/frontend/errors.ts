// asmlift — the shared DESIGNED loud-failure signal for ISA frontends. A frontend throws this when
// it meets a construct it cannot faithfully model (an out-of-scope call, an indirect/tail transfer,
// a stack frame it can't abstract) — the "fail LOUD, never silently miscompile" contract for cases
// the `opaque`-destination path cannot reach: an instruction whose clobbered register is IMPLICIT
// (a call's return reg) or a control transfer with no data destination at all. Distinct from a
// runtime crash (TypeError/RangeError): this is a catchable, intentional "out of scope" boundary
// signal. `PpcUnsupportedError` subclasses it (annotate-mode classification and the loud-error
// tests use `instanceof` against this base).
export class FrontendUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendUnsupportedError';
  }
}
