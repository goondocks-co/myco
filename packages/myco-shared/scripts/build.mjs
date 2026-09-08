// Bun.build replacement for tsup. Declarations come from tsc (Bun emits no .d.ts).
//
// The entrypoints are DERIVED from the package's own `exports` map. A
// hand-listed array beside that map is a second copy of it, and the copy fails
// silently: a subpath declared in `exports` but missing here typechecks
// everywhere, is simply absent from `dist/`, and first shows up as a bundled
// consumer failing to resolve it at runtime. Reading the contract removes the
// site rather than guarding it.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The source module behind every published subpath, from `exports`. */
function entrypoints() {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8'));
  const sources = Object.values(pkg.exports).map((entry) =>
    resolve(pkgRoot, entry.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')),
  );
  if (sources.length === 0) throw new Error('[myco-shared build] exports map is empty');
  return [...new Set(sources)];
}

rmSync(resolve(pkgRoot, 'dist'), { recursive: true, force: true }); // matches tsup clean:true

const result = await Bun.build({
  entrypoints: entrypoints(),
  outdir: resolve(pkgRoot, 'dist'),
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
