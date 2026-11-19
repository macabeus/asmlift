// Imported first (`node --import`) by every process that compiles behind a candidate store, ahead of
// tsx's loader, which then reads each source through this hook: it records the sha256 of the bytes
// every file module is compiled from, for loaded-code.ts. JavaScript, because it loads before tsx.
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const sources = new Map();
globalThis[Symbol.for('asmlift.loaded-code')] = sources;

const bytesOf = (source) =>
  typeof source === 'string'
    ? source
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith('file:')) {
      const path = fileURLToPath(url);
      const now =
        result.source === undefined || result.source === null
          ? new Error(`${path} was loaded without its source passing the load hook, so nothing is cached`)
          : createHash('sha256').update(bytesOf(result.source)).digest('hex');
      const was = sources.get(path);
      sources.set(
        path,
        was === undefined || was === now
          ? now
          : was instanceof Error
            ? was
            : new Error(`${path} was loaded twice, from two texts, so nothing is cached`),
      );
    }
    return result;
  },
});
