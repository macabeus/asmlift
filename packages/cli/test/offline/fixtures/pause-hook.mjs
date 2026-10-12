// A load hook, imported last so it runs first, that stops the process once the module at
// `$PAUSE_AT` (a URL) has been fetched — `paused` on stdout — until a byte arrives on stdin.
import { readSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url === process.env.PAUSE_AT) {
      writeSync(1, 'paused\n');
      readSync(0, Buffer.alloc(1), 0, 1, null);
    }
    return result;
  },
});
