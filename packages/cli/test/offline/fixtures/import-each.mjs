// Imports each file named in the JSON array argument, in order.
import { pathToFileURL } from 'node:url';

for (const f of JSON.parse(process.argv[2])) {
  await import(pathToFileURL(f).href);
}
