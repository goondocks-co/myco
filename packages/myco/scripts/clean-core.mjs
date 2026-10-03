// Narrow pre-build clean for `build:core`. Removes the files tsup produces
// (dist/*.js, dist/*.js.map, dist/src/**) and leaves the rest of dist/ as it
// is; tsup's own `clean: true` would wipe the entire outDir.
import nodeFs from 'node:fs';
const { readdirSync, rmSync, existsSync } = nodeFs;
import path from 'node:path';

const dist = path.resolve('dist');
if (!existsSync(dist)) process.exit(0);

rmSync(path.join(dist, 'src'), { recursive: true, force: true });
for (const entry of readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) {
    rmSync(path.join(dist, entry.name), { force: true });
  }
}
