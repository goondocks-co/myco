// Narrow pre-build clean for `build:core`. Removes the files tsup produces
// (dist/*.js, dist/*.js.map) while leaving dist/ui/ untouched. tsup's own
// `clean: true` wipes the entire outDir, which would destroy the vite-built
// UI bundle whenever build:core runs without build:ui.
import { readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
if (!existsSync(dist)) process.exit(0);

for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
    rmSync(path.join(dist, entry.name), { force: true });
  }
}
