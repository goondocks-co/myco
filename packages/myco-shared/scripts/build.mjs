// Bun.build replacement for tsup. Declarations come from tsc (Bun emits no .d.ts).
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(resolve(pkgRoot, 'dist'), { recursive: true, force: true }); // matches tsup clean:true

const result = await Bun.build({
  entrypoints: [resolve(pkgRoot, 'src/index.ts')],
  outdir: resolve(pkgRoot, 'dist'),
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
