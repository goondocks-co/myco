/**
 * Rollback safety across the schema gap.
 *
 * A binary can only open vaults at or below its compiled `SCHEMA_VERSION`
 * — an older binary meeting a newer vault refuses at boot. So restoring
 * or downgrading to a binary whose supported version is below any local
 * Grove's stamped version produces a machine whose daemon cannot start.
 * The rollback/downgrade decision must therefore compare the two, and
 * everything needed to decide lives here:
 *
 * - the vault side: the MAX stamped `schema_version` across every Grove
 *   DB in the home (migrations run lazily per Grove, so the max — not the
 *   boot Grove alone — is what the candidate binary must support);
 * - the binary side: each binary's supported version, known in-process
 *   for the running binary and via a self-stamp file
 *   (`versions/<v>/schema-version`, written at daemon boot) for staged
 *   versions that are not running;
 * - the refusal predicate and the typed error the manual downgrade
 *   entrances surface.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import { GROVES_DIRNAME, resolveGroveDbPath } from '../grove/paths.js';
import { versionDir } from '../install/managed-binary.js';

/** Self-stamp filename inside a `versions/<v>/` slot. */
const SUPPORTED_SCHEMA_STAMP = 'schema-version';

/**
 * The highest stamped `schema_version` across every Grove DB under
 * `home`, or null when none is readable (fresh install, no Groves).
 *
 * Read-only opens; any per-Grove failure (locked, corrupt, pre-schema)
 * skips that Grove rather than failing the scan — a missing answer must
 * never brick an upgrade flow, it just means "nothing to protect" for
 * the Groves that couldn't be read.
 */
export function readMaxStampedSchemaVersion(home: string): number | null {
  const grovesRoot = path.join(home, GROVES_DIRNAME);
  let entries: string[];
  try {
    entries = fs.readdirSync(grovesRoot);
  } catch {
    return null;
  }

  let max: number | null = null;
  for (const entry of entries) {
    // The groves dir holds non-Grove entries too (the bootstrap anchor,
    // editor droppings); resolveGroveDbPath validates the id format and
    // throws on them — skip, same as any other unreadable entry.
    let dbPath: string;
    try {
      dbPath = resolveGroveDbPath(entry, home);
    } catch {
      continue;
    }
    if (!fs.existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        // The daemon is normally stopped when this runs, but a straggler
        // holding the write lock should delay us briefly, not skip a Grove.
        db.exec('PRAGMA busy_timeout = 2000');
        const row = db
          .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
          .get() as { version: number } | null;
        if (typeof row?.version === 'number' && (max === null || row.version > max)) {
          max = row.version;
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return max;
}

/**
 * Write this binary's supported schema version into its own
 * `versions/<ownVersion>/` slot so a FUTURE rollback/downgrade decision
 * can evaluate this version without running it. Called at daemon boot;
 * best-effort and idempotent.
 *
 * Skips (never creates) a missing version dir — a curl/npm-installed
 * binary that never staged has no slot, and creating a binary-less dir
 * would confuse `resolveNewestStagedVersion`/`pruneVersions` (the
 * `markAdoptFailed` precedent).
 */
export function stampSupportedSchemaVersion(
  home: string,
  platform: NodeJS.Platform,
  ownVersion: string,
  localAppData?: string,
): void {
  try {
    const dir = versionDir(home, platform, ownVersion, localAppData);
    if (!fs.existsSync(dir)) return;
    const target = path.join(dir, SUPPORTED_SCHEMA_STAMP);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${SCHEMA_VERSION}\n`, 'utf-8');
    fs.renameSync(tmp, target);
  } catch {
    /* best effort */
  }
}

/**
 * A staged version's self-stamped supported schema version, or null when
 * the slot has no stamp (a pre-1.3.0 binary, or one that never booted).
 * Null means UNKNOWN — the refusal predicate fails closed on it.
 */
export function readSupportedSchemaVersion(
  home: string,
  platform: NodeJS.Platform,
  version: string,
  localAppData?: string,
): number | null {
  try {
    const raw = fs.readFileSync(
      path.join(versionDir(home, platform, version, localAppData), SUPPORTED_SCHEMA_STAMP),
      'utf-8',
    );
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The refusal predicate. `vaultSchemaVersion === null` (no readable
 * vault) allows — a fresh install has nothing to protect and must never
 * be bricked by the guard. A non-null vault with an UNKNOWN candidate
 * (`supportedSchemaVersion === null`) refuses — the candidate would
 * either refuse the vault itself at boot (the worse, signal-free way) or,
 * pre-refusal-era, reapply old DDL over a newer schema.
 */
export function rollbackWouldCrossSchemaGap(
  vaultSchemaVersion: number | null,
  supportedSchemaVersion: number | null,
): boolean {
  if (vaultSchemaVersion === null) return false;
  return supportedSchemaVersion === null || supportedSchemaVersion < vaultSchemaVersion;
}

/**
 * Typed refusal for the manual downgrade entrances (`myco upgrade
 * <older-version>`, revert-to-stable). 422 at the API, exit-1 with the
 * message at the CLI.
 */
export class SchemaGapDowngradeError extends Error {
  readonly code = 'schema_gap_downgrade';

  constructor(
    readonly targetVersion: string,
    readonly vaultSchemaVersion: number,
    readonly supportedSchemaVersion: number | null,
  ) {
    super(
      `Cannot downgrade to myco ${targetVersion}: this machine's data is at storage `
        + `format v${vaultSchemaVersion}, which that version `
        + (supportedSchemaVersion === null
          ? 'is not known to support'
          : `does not support (it supports up to v${supportedSchemaVersion})`)
        + '. A downgraded binary would refuse to start. To go back anyway, restore a '
        + 'backup taken before the upgrade into a fresh data directory — see '
        + '"Rollback" in docs/upgrade.md.',
    );
    this.name = 'SchemaGapDowngradeError';
  }
}
