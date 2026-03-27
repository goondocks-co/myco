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

/** Regex matching both quoted and unquoted YAML: type: memory, type: "memory", type: 'memory' */
const MEMORY_TYPE_PATTERN = /type:\s*["']?memory["']?/g;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'rename-memories-to-spores',
    migrate: (doc, vaultDir) => {
      // Config: rename context.layers.memories → context.layers.spores
      const context = doc.context as Record<string, unknown> | undefined;
      const layers = context?.layers as Record<string, unknown> | undefined;
      if (layers && 'memories' in layers && !('spores' in layers)) {
        layers.spores = layers.memories;
        delete layers.memories;
      }

      // Vault: rename memories/ directory → spores/
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

      // Update frontmatter type: memory → type: spore (handles quoted and unquoted)
      const walkUpdate = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walkUpdate(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          MEMORY_TYPE_PATTERN.lastIndex = 0;
          if (MEMORY_TYPE_PATTERN.test(content)) {
            MEMORY_TYPE_PATTERN.lastIndex = 0;
            fs.writeFileSync(fullPath, content.replace(MEMORY_TYPE_PATTERN, 'type: spore'));
          }
        }
      };
      walkUpdate(sporesDir);

      // Legacy: update wikilink references in Markdown files (pre-SQLite migration): [[memories/...]] → [[spores/...]]
      const walkLinks = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walkLinks(fullPath); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes('memories/')) {
            fs.writeFileSync(fullPath, content.replace(/memories\//g, 'spores/'));
          }
        }
      };
      walkLinks(vaultDir);
    },
  },
  {
    version: 2,
    name: 'consolidation-boolean-to-object',
    migrate: (doc) => {
      const digest = doc.digest as Record<string, unknown> | undefined;
      if (!digest) return;

      const consolidation = digest.consolidation;
      if (typeof consolidation === 'boolean') {
        digest.consolidation = { enabled: consolidation, max_tokens: 2048 };
      }
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

    migration.migrate(doc, vaultDir);
    doc.config_version = migration.version;
    ran = true;
  }

  if (ran) {
    const from = currentVersion;
    const to = (doc.config_version as number) ?? 0;
    log?.(`Migrated config from v${from} to v${to}`);
  }

  return ran;
}
