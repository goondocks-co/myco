/**
 * Config and vault migrations — run once per version, tracked by config_version.
 *
 * Each migration has a version number, a name, and a function that receives
 * the raw parsed YAML doc and the vault directory. Migrations run in order
 * and are skipped if config_version is already past them.
 *
 * To add a new migration:
 * 1. Add an entry to MIGRATIONS with the next version number
 * 2. Write the migrate function — it receives the mutable doc and vaultDir
 * 3. The framework handles version tracking and writing the config back
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  name: string;
  migrate: (doc: Record<string, unknown>, vaultDir: string) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'rename-memories-to-spores-config',
    migrate: (doc) => {
      // Rename context.layers.memories → context.layers.spores
      const context = doc.context as Record<string, unknown> | undefined;
      const layers = context?.layers as Record<string, unknown> | undefined;
      if (layers && 'memories' in layers && !('spores' in layers)) {
        layers.spores = layers.memories;
        delete layers.memories;
      }
    },
  },
  {
    version: 2,
    name: 'rename-memories-to-spores-vault',
    migrate: (_, vaultDir) => {
      // Rename memories/ directory to spores/, update frontmatter
      const memoriesDir = path.join(vaultDir, 'memories');
      const sporesDir = path.join(vaultDir, 'spores');

      if (!fs.existsSync(memoriesDir)) return;

      if (fs.existsSync(sporesDir)) {
        // Both exist (interrupted migration) — merge remaining files
        const moveRemaining = (srcDir: string, destDir: string): void => {
          for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            if (entry.isDirectory()) {
              if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
              moveRemaining(srcPath, destPath);
            } else if (!fs.existsSync(destPath)) {
              fs.renameSync(srcPath, destPath);
            }
          }
        };
        moveRemaining(memoriesDir, sporesDir);
        fs.rmSync(memoriesDir, { recursive: true, force: true });
      } else {
        fs.renameSync(memoriesDir, sporesDir);
      }

      // Update frontmatter type: memory → type: spore
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes('type: memory')) {
            fs.writeFileSync(fullPath, content.replace(/type: memory/g, 'type: spore'));
          }
        }
      };
      walk(sporesDir);
    },
  },
];

/** Current migration version — the highest version in MIGRATIONS. */
export const CURRENT_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Run all pending migrations on the raw config doc.
 * Returns true if any migrations ran (caller should reindex).
 */
export function runMigrations(
  doc: Record<string, unknown>,
  vaultDir: string,
  log?: (message: string) => void,
): boolean {
  const currentVersion = (doc.config_version as number) ?? 0;
  let ran = false;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    log?.(`Running migration ${migration.version}: ${migration.name}`);
    migration.migrate(doc, vaultDir);
    doc.config_version = migration.version;
    ran = true;
  }

  return ran;
}
