/**
 * Pre-migration backup checkpoint — the data-preservation half of upgrade
 * rollback safety.
 *
 * Rolling back a binary across a schema migration is refused (the old
 * binary cannot read the migrated vault), so the pre-migration dump taken
 * here is the one recovery artifact that spans the gap. It is wired into
 * `createSchema`'s pre-migration seam (see `setPreMigrationHook`), which
 * fires only when a real migration is imminent — once per Grove per
 * upgrade — and covers every `createSchema` caller in the REGISTERING
 * process. Registration happens at every entry point that can migrate:
 * the daemon composition root (boot, lazy Grove opens, agent runs) AND
 * the CLI dispatcher (grove activation, `myco update`, provisioning) —
 * kept honest by the installation-coverage assertion in
 * tests/db/create-schema-call-sites.test.ts.
 */

import { setPreMigrationHook, type PreMigrationContext } from '@myco/db/schema.js';
import { groveIdFromDbPath } from '@myco/grove/paths.js';
import { createGroveBackup } from './service.js';

/**
 * A required pre-migration checkpoint could not be taken, so the schema
 * migration was aborted with the vault's stamped version unchanged.
 * Fail-closed by design: migrating without the safety net would leave a
 * vault that can neither roll back nor be recovered if the migration or
 * the new binary misbehaves.
 */
export class PreMigrationCheckpointError extends Error {
  readonly code = 'pre_migration_checkpoint_failed';

  constructor(
    readonly groveId: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    cause: unknown,
  ) {
    super(
      `Pre-migration backup failed for Grove ${groveId} `
        + `(schema v${fromVersion} -> v${toVersion}); the migration was aborted `
        + `and the vault is unchanged. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PreMigrationCheckpointError';
  }
}

/**
 * Register the checkpoint as the process-wide pre-migration hook.
 *
 * Non-Grove databases (temp snapshots, ad-hoc test DBs — anything whose
 * path doesn't resolve a Grove id) are skipped, mirroring the backup
 * engine's own lineage rule. `mycoHome` must be the resolved home of the
 * process so dogfood and prod checkpoints land in their own trees.
 */
export function installPreMigrationCheckpoint(opts: { mycoHome: string }): void {
  setPreMigrationHook((ctx: PreMigrationContext) => {
    const groveId = groveIdFromDbPath(ctx.db.filename);
    if (!groveId) return;
    try {
      const result = createGroveBackup({
        groveId,
        db: ctx.db,
        machineId: ctx.machineId,
        mycoHome: opts.mycoHome,
        // Pinned against retention: this is the one artifact that spans
        // the schema gap the rollback refusal points at.
        pin: true,
      });
      console.log(
        `[backup] pre-migration checkpoint for Grove ${groveId} `
          + `(schema v${ctx.fromVersion} -> v${ctx.toVersion}): ${result.file_path}`,
      );
    } catch (err) {
      throw new PreMigrationCheckpointError(groveId, ctx.fromVersion, ctx.toVersion, err);
    }
  });
}
