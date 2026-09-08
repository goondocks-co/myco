/**
 * Indexes read by a Deployment-wide access path rather than by Project.
 *
 * Every index on a Project-scoped table leads with `project_id`, and two gates
 * hold that (`gates.test.ts` over every CREATE INDEX, `schema.test.ts` over the
 * v2 tables). The indexes named here are the exceptions both gates admit, each
 * with the Deployment-wide read it serves; one set, so a new exception is
 * declared once and judged the same way by both.
 */
export const DEPLOYMENT_ACCESS_PATH_INDEXES: ReadonlyMap<string, string> = new Map([
  ['idx_blob_reservations_credential', 'a credential spans every Project in its Deployment; the quota admission looks reservations up by credential'],
  ['idx_agent_runs_credential', 'the foreign key on a run\'s dispatching credential is checked by credential alone'],
  ['idx_external_grants_hash', 'a grant key authenticates by its hash before any Project is known'],
  ['idx_external_grants_expiry', 'grant expiry sweeps the Deployment'],
  ['idx_events_token_only', 'a credential\'s events are counted by token across its Projects'],
  ['idx_search_blob_pending', 'pending search work is ordered across the Deployment by its last attempt'],
  ['idx_transcripts_backlog', 'the transcript parse backlog is ordered across the Deployment, live before imported'],
  ['idx_agent_runs_claimable', 'a worker claims the next queued run across the Deployment, in queue order'],
  ['idx_agent_runs_lease', 'the lease foreign key is checked by credential alone, and worker liveness reads leases by the credential that holds them'],
]);

/** True when `statement` creates one of the indexes above. */
export function isDeploymentAccessPath(statement: string): boolean {
  const name = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(statement)?.[1];
  return name !== undefined && DEPLOYMENT_ACCESS_PATH_INDEXES.has(name);
}
