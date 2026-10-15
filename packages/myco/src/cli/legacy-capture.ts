import { REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import type { LegacyMigrationState } from '@myco/member/legacy-migration.js';
import { LEGACY_AGENT_DEFERRAL } from '@goondocks/myco-shared/setup-guidance';

export const legacyMovedNotice = (name: string, state: 'archived' | 'deleted'): string => `${name} has been moved; its project is ${state} on the Deployment.`;
export const LEGACY_DESTINATION_HINT = 'Some Myco 1.4 data has no destination yet; run myco setup --cutover to preview the handover.';

export function legacyConfirmationHint(confirmation: LegacyMigrationState['confirmation'], projects: LegacyMigrationState['confirmationProjects'] = []): string | null {
  const names = projects.filter(project => project.confirmation === confirmation).map(project => project.name).join(', ') || 'this project';
  switch (confirmation) {
    case 'no-destination': return `Myco couldn't find a Deployment holding the earlier move for ${names}. Run myco setup --cutover to choose a destination, or skip the project. Keep the 1.4 data.`;
    case 'ambiguous': return `More than one Deployment holds the earlier move for ${names}. Run myco setup --cutover to choose its destination, or skip the project. Keep the 1.4 data.`;
    case 'sign-in-required': return `Myco couldn't confirm earlier moves; ${REJOIN_HINT}. Then run myco setup --cutover. Keep the 1.4 data.`;
    case 'pending': return "Earlier moves are unconfirmed; Myco will check again. Keep the 1.4 data.";
    case 'unavailable': return "Myco couldn't confirm earlier moves; it will check again when online. Keep the 1.4 data.";
    case 'update-required': return "Myco couldn't confirm earlier moves; update the Deployment, then run myco setup --cutover. Keep the 1.4 data.";
    case 'project-missing': return "A project is no longer on its Deployment; keep the 1.4 data and run myco setup --cutover to review its destination.";
    case 'busy': return "Another cutover is running; keep the 1.4 data and check again when it finishes.";
    default: return null;
  }
}

/** Capture ownership determines whether agent setup must wait for cutover. */
export function legacyCaptureGuidance(migration: LegacyMigrationState) {
  const hint = legacyConfirmationHint(migration.confirmation, migration.confirmationProjects) ?? (migration.state === 'needs-destination' && migration.legacyOwnsCapture !== true
    ? LEGACY_DESTINATION_HINT : null);
  const deferral = migration.state === 'unavailable'
    ? `Agent setup deferred: ${migration.detail}. Inspect ${migration.file}, then run myco setup --cutover.`
    : migration.state === 'unmoved' || migration.state === 'changed' || migration.legacyOwnsCapture === true
      ? LEGACY_AGENT_DEFERRAL : null;
  return {
    notice: migration.terminalProjects?.map(project => legacyMovedNotice(project.name, project.state)).join(' ') ?? null,
    status: migration.state === 'unavailable' ? 'unavailable' as const : deferral === null ? 'ready' as const : 'deferred' as const,
    hint,
    deferral,
    warning: migration.state === 'changed' ? migration.warning : null,
  };
}
