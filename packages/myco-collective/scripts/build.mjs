// Bun.build replacement for tsup. clean-core.mjs runs first and does the
// scoped clean (preserves dist/ui owned by vite) — do NOT wipe dist here.
// Multi-entry → splitting REQUIRED.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = await Bun.build({
  entrypoints: [resolve(pkgRoot, 'src/cli.ts'), resolve(pkgRoot, 'src/main.ts')],
  outdir: resolve(pkgRoot, 'dist'),
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  splitting: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
