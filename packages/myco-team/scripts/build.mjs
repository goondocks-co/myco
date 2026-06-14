// Bun.build replacement for tsup. Multi-entry → splitting REQUIRED.
import { rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8'));

rmSync(resolve(pkgRoot, 'dist'), { recursive: true, force: true }); // tsup clean:true

const result = await Bun.build({
  entrypoints: [resolve(pkgRoot, 'src/cli.ts'), resolve(pkgRoot, 'src/main.ts')],
  outdir: resolve(pkgRoot, 'dist'),
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  splitting: true, // REQUIRED: factor shared graph into one chunk, like tsup
  external: ['better-sqlite3', 'sqlite-vec', '@anthropic-ai/claude-agent-sdk', 'yaml'],
  define: { __MYCO_TEAM_VERSION__: JSON.stringify(pkg.version) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
