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

/** Where the output goes: `dist` beside the package, or the `--outdir` a caller names. */
function outdir() {
  const named = process.argv.slice(2).find((arg) => arg.startsWith('--outdir='));
  return named ? resolve(named.slice('--outdir='.length)) : resolve(pkgRoot, 'dist');
}

const out = outdir();

rmSync(out, { recursive: true, force: true }); // matches tsup clean:true

const result = await Bun.build({
  entrypoints: entrypoints(),
  outdir: out,
  // Stated rather than inferred: the output layout is what `exports` promises,
  // `./dist/<name>.js`, and an inferred common root makes that layout depend on
  // which entry points happen to exist.
  root: resolve(pkgRoot, 'src'),
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
