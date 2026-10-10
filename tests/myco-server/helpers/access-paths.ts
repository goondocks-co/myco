/**
 * Indexes read by a Deployment-wide access path rather than by Project.
 *
 * Every index on a Project-scoped table leads with `project_id`, and two gates
 * hold that (`gates.test.ts` over the live schema indexes, `schema.test.ts` over the
 * v2 tables). The indexes named here are the exceptions both gates admit, each
 * with the Deployment-wide read it serves; one set, so a new exception is
 * declared once and judged the same way by both.
 */
export const DEPLOYMENT_ACCESS_PATH_INDEXES: ReadonlyMap<string, string> = new Map([
  ['idx_agent_runs_retention', 'run retention seeks eligible terminal runs across the Deployment by cutoff and id'],
  ['idx_sessions_activity', 'power resolution seeks the newest capture receipt across the Deployment'],
  ['idx_agent_runs_activity', 'power resolution seeks the newest run start across the Deployment'],
  ['idx_agent_runs_task_live', 'embedding dispatch checks live runs by task and status across every Project'],
  ['idx_device_requests_pending_expiry', 'the enrollment sweep seeks expired undecided requests across the Deployment'],
  ['idx_device_requests_decided_expiry', 'the enrollment sweep seeks decided requests past retention across the Deployment'],
  ['idx_device_requests_source_pending', 'device admission counts live pending requests per trusted source across the Deployment'],
  ['idx_device_requests_source_created', 'device admission bounds starts in a minute per trusted source across the Deployment'],
  ['idx_device_requests_expiry', 'the enrollment sweep reclaims expired device requests across the Deployment, oldest expiry first'],
  ['idx_blob_reservations_credential', 'a credential spans every Project in its Deployment; the quota admission looks reservations up by credential'],
  ['idx_agent_runs_credential', 'the foreign key on a run\'s dispatching credential is checked by credential alone'],
  ['idx_external_grants_hash', 'a grant key authenticates by its hash before any Project is known'],
  ['idx_external_grants_expiry', 'grant expiry sweeps the Deployment'],
  ['idx_events_token_only', 'a credential\'s events are counted by token across its Projects'],
  ['idx_raw_archive_refs_due', 'raw archival seeks due hot sources by immutable receipt age across the Deployment'],
  ['idx_session_tombstones_created', 'the orphan sweep seeks recent session deletion admission across the Deployment by creation time'],
  ['idx_search_blob_pending', 'pending search work is ordered across the Deployment by its last attempt'],
  ['idx_transcripts_backlog', 'the transcript parse backlog is ordered across the Deployment, live before imported'],
  ['idx_transcripts_parser_version', 'the bounded parser upgrade sweep walks older versions across the Deployment'],
  ['idx_transcripts_terminal', 'terminal transcript outcomes are ordered across the Deployment by lane and receipt'],
  ['idx_fleet_queue', 'fleet readiness aggregates the Deployment queue by task and hold over a covering index'],
  ['idx_fleet_legacy_leases', 'legacy fleet inventory starts from currently running member-held leases across the Deployment'],
  ['idx_runner_attempt_history', 'each runner reads its newest persistent attempt across Projects'],
  ['idx_runner_run_terminal', 'each runner reads its newest terminal result across Projects'],
  ['idx_agent_runs_claimable', 'a worker claims the next queued run across the Deployment, in queue order'],
  ['idx_agent_runs_lease', 'the lease foreign key is checked by credential alone, and worker liveness reads leases by the credential that holds them'],
  ['idx_blob_reservations_expiry', 'the object-release drain consumes expired upload authorities across the Deployment, oldest expiry first'],
  ['idx_object_releases_created', 'the object-release drain deletes journaled objects across the Deployment, oldest first'],
  ['idx_recovery_holds_open', 'at most one recovery hold was open in a Deployment, before step 43 gave a hold its holder'],
  ['idx_recovery_holds_open_holder', "at most one recovery hold of each holder is open in a Deployment: its own export producer's, and an operator backup's"],
  ['idx_sessions_untitled_ended', 'the titling convergence takes ended, untitled sessions across the Deployment, newest end first'],
  ['idx_sessions_untitled_open', 'the titling convergence takes open, untitled sessions across the Deployment by how long they have been quiet, newest first'],
  ['idx_sessions_titled_recent', 'the titling convergence takes titled sessions active within the day across the Deployment, most recent first'],
  ['idx_worker_contacts_seen', 'the worker-contact sweep forgets Deployment-wide observations by age, and a worker names no Project'],
  ['idx_worker_model_catalogs_received', 'Settings reads the model lists machines sent lately, and the lease sweep forgets the rest by age; a machine names no Project'],
  ['idx_sessions_occurred_deployment', 'the sessions list spans every Project, newest first'],
  ['idx_spores_created_deployment', 'the spores list spans every Project, newest first'],
  ['idx_plans_updated_deployment', 'the plans list spans every Project, most recently updated first'],
  ['idx_sessions_capture', 'capture recency is read per machine and agent across every Project, over a recent window of receipts'],
  ['idx_sessions_harness_live', 'Health seeks the latest live capture of a provisioned machine and harness across every Project'],
  ['idx_sessions_machine_live', 'Health reads recent live machine activity across every Project, including an unprovisioned harness'],
  ['idx_sessions_working', 'the sessions working now are read across every Project, the open turns alone'],
  ['idx_agent_runs_actor_entry', 'an actor\'s daily ceiling is counted across every Project, by task, actor and instant'],
  ['idx_uncaptured_roots_member', 'a repository a machine could not capture belongs to a machine and its member, not a Project: a member\'s own are read by member, most recently missed first'],
  ['idx_uncaptured_roots_seen', 'an administrator reads every machine\'s repositories that could not be captured, most recently missed first'],
  ['idx_machine_claims_member', 'a machine belongs to a member, not a Project: a viewer\'s own machines are named, and a member\'s page of machines read, by member'],
  ['idx_machine_claims_claimed', 'machine claims are paged across the Deployment by claim time and id'],
  ['idx_member_credentials_machine', 'a canonical machine summary seeks its credentials by machine and newest issue time'],
  ['idx_runner_contacts_seen', 'the worker-contact sweep forgets runner observations by age across the Deployment, and a runner names no Project'],
  ['idx_runner_model_catalogs_received', 'Settings reads the model lists runners sent lately, and the lease sweep forgets the rest by age; a runner names no Project'],
  ['idx_device_requests_candidate', 'a runner registration admits each client-generated candidate once across the Deployment, before any runner exists'],
]);

/** True when `statement` creates one of the indexes above. */
export function isDeploymentAccessPath(statement: string): boolean {
  const name = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(statement)?.[1];
  return name !== undefined && DEPLOYMENT_ACCESS_PATH_INDEXES.has(name);
}
