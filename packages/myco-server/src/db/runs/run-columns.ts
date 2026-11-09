/** The columns every read of a run row selects, under the names `RunRow` declares. */
export const RUN_COLUMNS = `id, harness, agent_id AS agentId, task, status, run_context AS runContext, started_at AS startedAt,
    resumed_at AS resumedAt, completed_at AS completedAt, error, checkpoints,
    resumable, resume_status AS resumeStatus, resume_attempts AS resumeAttempts,
    dry_run AS dryRun, model, dispatched_by AS dispatchedBy, lease_expires_at AS leaseExpiresAt`;
