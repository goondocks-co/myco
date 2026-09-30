/**
 * Health's wire shapes, as the dashboard declares them, match the server's.
 *
 * `features/admin/health/wire.ts` declares what Health reads of the measures,
 * backups, store checks, housekeeping and automatic recovery; this file holds
 * each to the server's own declaration. The assertions are types: `npm run
 * typecheck:tests` fails when a shape drifts, and the one runtime expectation
 * keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/admin/health/wire.ts';
import type { KpiReport } from '../../packages/myco-server/src/read/kpis.ts';
import type { ListedBackup, RestoreOutcome, previewRestore } from '../../packages/myco-server/src/core/backup.ts';
import type { MaintenanceCheckStatus, MaintenanceOutcome } from '../../packages/myco-server/src/core/store-maintenance.ts';
import type { TickReport } from '../../packages/myco-server/src/core/tick.ts';
import type { RecoverySchedule } from '../../packages/myco-server/src/core/recovery-schedule.ts';
import type { RecoveryProducerStatus } from '../../packages/myco-server/src/core/recovery-producer.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `POST /api/backups/{id}/restore-preview`: the body `handleRestorePreview` answers. */
type PreviewAnswer = NonNullable<Awaited<ReturnType<typeof previewRestore>>>;
/** `POST /api/backups/{id}/restore`: the body `handleRestoreBackup` answers. */
type RestoreAnswer = { applied: true } & RestoreOutcome;
/** `GET /api/recovery/exports`: the producer's status with the schedule, or that it could not be read. */
type RecoveryAnswer = RecoveryProducerStatus & { recoverable: false; schedule: RecoverySchedule | { unreadable: string } };

const SAME: [
  Same<Ui.KpiReport, KpiReport>,
] = [true];

const READS: [
  Reads<ListedBackup, Ui.BackupRow>,
  Reads<{ backups: ListedBackup[] }, Ui.BackupsAnswer>,
  Reads<PreviewAnswer, Ui.RestorePreview>,
  Reads<RestoreAnswer, Ui.RestoreOutcome>,
  Reads<MaintenanceOutcome, Ui.MaintenanceOutcome>,
  Reads<MaintenanceCheckStatus, Ui.CheckStatus>,
  Reads<{ checks: MaintenanceCheckStatus[] }, Ui.MaintenanceAnswer>,
  Reads<TickReport, Ui.TickReport>,
  Reads<RecoverySchedule, Ui.RecoverySchedule>,
  Reads<RecoveryAnswer, Ui.RecoveryStatus>,
] = [true, true, true, true, true, true, true, true, true, true];

describe("Health's wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
