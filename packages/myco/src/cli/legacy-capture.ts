import type { LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { LEGACY_AGENT_DEFERRAL } from '@goondocks/myco-shared/setup-guidance';

/** Capture ownership determines whether agent setup must wait for cutover. */
export function legacyCaptureGuidance(migration: LegacyMigrationState) {
  const hint = migration.state === 'needs-destination' && migration.legacyOwnsCapture !== true
    ? 'Moved by an earlier version; run `myco cutover --dry-run` to confirm where each project went.' : null;
  const deferral = migration.state === 'unavailable'
    ? `Agent setup deferred: ${migration.detail}. Inspect ${migration.file}, then run myco cutover --dry-run.`
    : migration.state === 'unmoved' || migration.state === 'changed' || migration.legacyOwnsCapture === true
      ? LEGACY_AGENT_DEFERRAL : null;
  return {
    status: migration.state === 'unavailable' ? 'unavailable' as const : deferral === null ? 'ready' as const : 'deferred' as const,
    hint,
    deferral,
    warning: migration.state === 'changed' ? migration.warning : null,
  };
}
