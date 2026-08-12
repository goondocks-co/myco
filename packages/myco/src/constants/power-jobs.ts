/**
 * Canonical names for PowerManager-registered jobs. Centralized so call
 * sites (registration, fan-out, tests, log scrapers) reference one
 * source of truth instead of duplicating string literals.
 */
export const POWER_JOB_NAMES = {
  EMBEDDING_RECONCILE: 'embedding-reconcile',
  SESSION_MAINTENANCE: 'session-maintenance',
  LOG_RETENTION: 'log-retention',
  AGENT_RUN_RETENTION: 'agent-run-retention',
  NOTIFICATION_RETENTION: 'notification-retention',
  AUTO_BACKUP: 'auto-backup',
  DATABASE_OPTIMIZE: 'database-optimize',
  DATABASE_INTEGRITY_CHECK: 'database-integrity-check',
  STAGING_GC: 'staging-gc',
  CANOPY_BACKGROUND_SCAN: 'canopy-background-scan',
  RELEASE_PROVENANCE_RECONCILE: 'release-provenance-reconcile',
  MANAGED_FILES_RECONCILE: 'managed-files-reconcile',
  SELF_RECONCILE: 'self-reconcile',
  /**
   * Periodic re-detection of installed coding agents. Walks the manifest
   * registry, checks each `detectionDir`, and installs Myco's global
   * config into any newly-detected agent. Idempotent.
   */
  SYMBIONT_DETECTION: 'symbiont-detection',
  /**
   * Periodic quiescence-gated convergence of capture buffer files into
   * the DB, plus convergence-aware retention (cleanup + quarantine).
   * Catches sessions whose buffers diverged without a restart or
   * register/event trigger to converge them.
   */
  CAPTURE_BUFFER_DRAIN: 'capture-buffer-drain',
  /**
   * Consume pending capture-only notice markers written by the hook-side
   * provisioner (which has no notifications DB) and emit the one-time
   * "new project is capture-only" drawer notice. The marker file is the
   * durable dedup; the sweep is a cheap per-project stat.
   */
  CAPTURE_ONLY_NOTICE_SWEEP: 'capture-only-notice-sweep',
  /**
   * Background update check + stage: resolves the channel target from
   * GitHub Releases and stages the binary under `versions/<v>/` when a
   * newer version is available. Respects the configured check cadence
   * (UPDATE_CHECK_INTERVAL_HOURS). No-ops on dev builds.
   *
   * Runs in idle/sleep only — no need to hit the network during active
   * use; cadence gate throttles to at most once per interval.
   */
  UPGRADE_AUTO_CHECK: 'upgrade-auto-check',
  /**
   * Idle-adopt: when a staged version strictly > current is present and
   * no update is already in-flight, spawns the adopt orchestrator and
   * requests cooperative shutdown. The `inFlight` guard (sentinel file)
   * is what makes this fire once-per-staged-version, not once-per-tick.
   *
   * Runs in idle/sleep only (`active` excluded — must not interrupt a
   * live session). `deep_sleep` doesn't tick, so it is also excluded.
   */
  UPGRADE_ADOPT: 'upgrade-adopt',
  /**
   * Detached-daemon self-heal: when this (lock-holding) daemon detects that a
   * supervisor unit is installed for its home but the supervisor-tracked PID is
   * NOT us — the detached-usurper signature behind the launchd respawn loop — it
   * spawns `myco service reconcile`, which cooperatively stops us and
   * re-bootstraps exactly one supervisor-tracked daemon.
   *
   * Idle/sleep only and two-tick latched so a transient status read can't
   * trigger it; gated on the MYCO_DAEMON_MANAGED marker so a hand-run
   * `myco daemon` is never auto-reconciled.
   */
  SERVICE_RECONCILE: 'service-reconcile',
  /**
   * Content claim system (Team Host WS2) expiry sweep: flips `active` claims
   * whose `expires_at` has passed to `expired`. Runs where the Grove lives —
   * the backstop that frees an abandoned lock even when release-on-detach
   * never fires (design doc §5: there is no reliable release-on-detach).
   * Active rows can arrive with `expires_at` already past (backup-restore/
   * project-copy), so this sweep never assumes active implies unexpired.
   */
  CONTENT_CLAIM_EXPIRY: 'content-claim-expiry',
  /**
   * Team Host — routed-transcripts cache GC (consolidation Task C-1). Prunes
   * `~/.myco-team/host/routed-transcripts/<machine>/<session>/` trees whose
   * session is BOTH fully mined and session-terminal (`status = 'completed'`
   * in the owning Grove). Never touches an in-flight or not-yet-terminal
   * session's tree — the host may be the only durable copy of a routed
   * session's transcript once the member rotates/trims its own file (data
   * preservation).
   */
  ROUTED_TRANSCRIPT_CACHE_GC: 'routed-transcript-cache-gc',
  /**
   * Team Host — `routed_event_dedup` idempotency-ledger prune (consolidation
   * Task C-1). Age-based (the ledger carries no `session_id` to gate on a
   * terminal signal): deletes rows older than ROUTED_EVENT_DEDUP_RETENTION_MS
   * (constants.ts — see that constant's doc for the retention reasoning).
   */
  ROUTED_EVENT_DEDUP_PRUNE: 'routed-event-dedup-prune',
} as const;

export type PowerJobName = (typeof POWER_JOB_NAMES)[keyof typeof POWER_JOB_NAMES];
