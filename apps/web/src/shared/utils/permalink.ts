// Shareable state-in-URL: the whole playground state lz-string-compressed into one URL param
// (`?s=`, see url-state.ts), so a permalink IS the repro — no server, nothing stored.
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

export interface ShareState {
  target: string;
  backend: string;
  name?: string; // only when the user overrode autodetection
  spec?: string; // C++ signature JSON, only when the backend is cpp and the user set one
  asm: string;
}

export function encodeShare(s: ShareState): string {
  return compressToEncodedURIComponent(JSON.stringify(s));
}

export function decodeShare(hash: string): ShareState | null {
  if (!hash) {
    return null;
  }
  try {
    const json = decompressFromEncodedURIComponent(hash);
    if (!json) {
      return null;
    }
    const o = JSON.parse(json);
    if (typeof o.target !== 'string' || typeof o.backend !== 'string' || typeof o.asm !== 'string') {
      return null;
    }
    return {
      target: o.target,
      backend: o.backend,
      asm: o.asm,
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.spec === 'string' ? { spec: o.spec } : {}),
    };
  } catch {
    return null;
  }
}
