import { renderMigrationFiles } from '../src/db/migrate.ts';

/** Writes every schema step as a numbered migration file into `migrations/` (or the directory named by `--out <dir>`), printing each file name. */
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const dir = outIndex >= 0 ? new URL(`${args[outIndex + 1].replace(/\/?$/, '/')}`, `file://${process.cwd()}/`) : new URL('../migrations/', import.meta.url);
for (const file of renderMigrationFiles()) {
  await Bun.write(new URL(file.name, dir), file.sql);
  process.stdout.write(`${file.name}\n`);
}
