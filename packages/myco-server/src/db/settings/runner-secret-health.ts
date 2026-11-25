import { RUNNER_KEY_RECHECK_MS } from '@goondocks/myco-shared/runner-fleet';
import type { StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import { CLAIM_SELECTION_REFUSED } from '../runs/claim-refusals.js';
import { assertion, write } from '../index.js';

export interface RunnerSecretVersion { slot: string; generation: string }
export type RunnerSecretAvailability = boolean | StoredKeyFailure;
export type RunnerSecretOutcome = 'accepted' | StoredKeyFailure;



/** A held key can serve one ordinary run after its recheck time. */
export const probeIsDue = (now: string) => `runner_retry_at <= ${now} AND NOT EXISTS (
  SELECT 1 FROM agent_runs WHERE dispatched_by=runner_probe AND status='running' AND lease_expires_at>${now})`;

const claimKey = assertion<[slot: string, generation: string, now: number]>({
  name: 'settings.claimRunnerKey', refusal: CLAIM_SELECTION_REFUSED, when: `EXISTS (
    SELECT 1 FROM deployment_secrets WHERE name=?1 AND iv=?2 AND (runner_failure IS NULL OR (${probeIsDue('?3')})))`,
});
export const admitRunnerSecret = (version: RunnerSecretVersion, now: number) => claimKey.bind(version.slot, version.generation, now);

const probeKey = write<[slot: string, generation: string, now: number, attempt: string, project: string, run: string]>({
  name: 'settings.probeRunnerKey', sql: `UPDATE deployment_secrets SET runner_probe=?4,runner_retry_at=?3+${RUNNER_KEY_RECHECK_MS}
    WHERE name=?1 AND iv=?2 AND runner_failure IS NOT NULL AND EXISTS (
      SELECT 1 FROM agent_runs WHERE project_id=?5 AND id=?6 AND dispatched_by=?4 AND status='running')`,
});
export const reserveRunnerSecretProbe = (version: RunnerSecretVersion, at: number, attempt: { id: string; project: string; run: string }) =>
  probeKey.bind(version.slot, version.generation, at, attempt.id, attempt.project, attempt.run);

/** A terminal attempt can report only the generation that it was handed at claim. */
export const RUNNER_SECRET_END = `CREATE TRIGGER IF NOT EXISTS runner_secret_end AFTER UPDATE OF status ON agent_runs
  WHEN OLD.status='running' AND NEW.status IN ('completed','failed') AND NEW.runner_secret_outcome IS NOT NULL BEGIN
    UPDATE deployment_secrets SET runner_failure=NULLIF(NEW.runner_secret_outcome,'accepted'),runner_retry_at=NEW.completed_at+${RUNNER_KEY_RECHECK_MS},
      runner_probe=CASE WHEN runner_probe=NEW.dispatched_by THEN NULL ELSE runner_probe END
      WHERE name=NEW.runner_secret_slot AND iv=NEW.runner_secret_generation AND
        (NEW.runner_secret_outcome<>'accepted' OR runner_probe=NEW.dispatched_by);
  END`;
