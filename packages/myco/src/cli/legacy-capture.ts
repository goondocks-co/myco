import type { LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { LEGACY_AGENT_DEFERRAL } from '@goondocks/myco-shared/setup-guidance';

/** Capture ownership determines whether agent setup must wait for cutover. */
export function legacyCaptureGuidance(migration: LegacyMigrationState) {
  const hint = migration.confirmation === 'unavailable'
    ? "Myco couldn't confirm earlier moves; it will check again when online. Keep the 1.4 data."
    : migration.state === 'needs-destination' && migration.legacyOwnsCapture !== true
    ? 'Earlier moves are unconfirmed; run `myco setup --cutover` to review each project destination, or preview manually with `myco cutover --dry-run`.' : null;
  const deferral = migration.state === 'unavailable'
    ? `Agent setup deferred: ${migration.detail}. Inspect ${migration.file}, then run myco setup --cutover.`
    : migration.state === 'unmoved' || migration.state === 'changed' || migration.legacyOwnsCapture === true
      ? LEGACY_AGENT_DEFERRAL : null;
  return {
    status: migration.state === 'unavailable' ? 'unavailable' as const : deferral === null ? 'ready' as const : 'deferred' as const,
    hint,
    deferral,
    warning: migration.state === 'changed' ? migration.warning : null,
  };
}
