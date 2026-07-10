/**
 * Structured log entry kinds — every logger call uses one of these.
 *
 * Convention: `{component}.{action}` — the component is derived from the
 * first segment (before the dot) for fast column filtering.
 */
export const LOG_KINDS = {
  // Context injection
  CONTEXT_QUERY: 'context.query',
  CONTEXT_SESSION: 'context.session',
  CONTEXT_PROMPT: 'context.prompt',
  CONTEXT_DIGEST: 'context.digest',
  CONTEXT_SEARCH: 'context.search',
  CONTEXT_EMBED: 'context.embed',
  CONTEXT_FILTER: 'context.filter',

  // Session lifecycle
  LIFECYCLE_REGISTER: 'lifecycle.register',
  LIFECYCLE_RECONCILE: 'lifecycle.reconcile',
  LIFECYCLE_UNREGISTER: 'lifecycle.unregister',
  LIFECYCLE_CLEANUP: 'lifecycle.cleanup',
  LIFECYCLE_AUTO_REGISTER: 'lifecycle.auto-register',

  // Hooks (event ingestion)
  HOOKS_EVENT: 'hooks.event',
  HOOKS_PROMPT: 'hooks.prompt',
  HOOKS_STOP: 'hooks.stop',
  HOOKS_TOOL: 'hooks.tool',
  HOOKS_SUBAGENT: 'hooks.subagent',

  // Capture (batch/activity recording)
  CAPTURE_BATCH: 'capture.batch',
  CAPTURE_ACTIVITY: 'capture.activity',
  CAPTURE_PLAN: 'capture.plan',
  CAPTURE_ATTACHMENT: 'capture.attachment',
  CAPTURE_BUFFER: 'capture.buffer',
  CAPTURE_RELEASE_PROVENANCE: 'capture.release-provenance',

  // Processor (stop-event session processing)
  PROCESSOR_SESSION: 'processor.session',
  PROCESSOR_TRANSCRIPT: 'processor.transcript',
  PROCESSOR_BATCH: 'processor.batch',
  PROCESSOR_TITLE: 'processor.title',

  // Agent
  AGENT_RUN: 'agent.run',
  AGENT_PHASE: 'agent.phase',
  AGENT_TASK: 'agent.task',
  AGENT_AUTO_RUN: 'agent.auto-run',
  AGENT_ERROR: 'agent.error',

  // Embedding
  EMBEDDING_EMBED: 'embedding.embed',
  EMBEDDING_RECONCILE: 'embedding.reconcile',
  EMBEDDING_SEARCH: 'embedding.search',
  EMBEDDING_REBUILD: 'embedding.rebuild',
  EMBEDDING_CLEANUP: 'embedding.cleanup',
  EMBEDDING_PROVIDER: 'embedding.provider',

  // Database maintenance
  DATABASE_OPTIMIZE: 'database.optimize',
  DATABASE_VACUUM: 'database.vacuum',
  DATABASE_REINDEX: 'database.reindex',
  DATABASE_INTEGRITY_CHECK: 'database.integrity-check',
  DATABASE_INTEGRITY_ISSUES: 'database.integrity-issues',
  DATABASE_ERROR: 'database.error',

  // Power management
  POWER_TICK: 'power.tick',
  POWER_STATE: 'power.state',
  POWER_JOB: 'power.job',
  POWER_JOB_ERROR: 'power.job-error',

  // Daemon core
  DAEMON_START: 'daemon.start',
  DAEMON_CONFIG: 'daemon.config',
  DAEMON_READY: 'daemon.ready',
  DAEMON_MIGRATION: 'daemon.migration',
  DAEMON_PORT: 'daemon.port',
  DAEMON_RECONCILE: 'daemon.reconcile',
  DAEMON_LAG: 'daemon.lag',
  DAEMON_STATE_MUTATION: 'daemon.state-mutation',
  DAEMON_UNHANDLED_REJECTION: 'daemon.unhandled_rejection',
  DAEMON_UNCAUGHT_EXCEPTION: 'daemon.uncaught_exception',
  DAEMON_LOGGER: 'daemon.logger',
  TENANCY_VIOLATION: 'tenancy.violation',

  // Scope iteration (forEachRegisteredProject / forEachGrove)
  SCOPE_TREE_UNAVAILABLE: 'scope.tree_unavailable',

  // Provider-level fetch instrumentation (cross-runtime: anything that
  // routes outbound LLM/embedding requests through `instrumentedFetch`).
  FETCH_START: 'fetch.start',
  FETCH_COMPLETE: 'fetch.complete',
  FETCH_TIMEOUT: 'fetch.timeout',
  FETCH_STALL: 'fetch.stall',
  FETCH_ABORT: 'fetch.abort',
  // OpenRouter (and any Responses-API-shaped provider) can return HTTP 200
  // for an upstream provider failure — status:"failed"/"incomplete" with an
  // error body and empty/reasoning-only output. The OpenAI Agents SDK reads
  // only output/usage and never checks status/error, so left unguarded this
  // becomes a silent zero-item turn that loops to MaxTurnsExceededError.
  // Emitted by openai.ts's harnessFetch wrapper when it converts one of
  // these 200-wrapped failures into a synthesized error response.
  FETCH_PROVIDER_FAILURE: 'fetch.provider-failure',

  // Server (HTTP)
  SERVER_REQUEST: 'server.request',
  SERVER_STATIC: 'server.static',
  SERVER_ERROR: 'server.error',
  // Team Host — the overlay-facing transport boundary (second listener + gate).
  HOST_SERVE: 'host.serve',

  // Session maintenance job
  MAINTENANCE_SESSION: 'maintenance.session',
  MAINTENANCE_EMBEDDING: 'maintenance.embedding',
  MAINTENANCE_STAGING_GC: 'maintenance.staging-gc',

  // Canopy code intelligence
  CANOPY_SCAN: 'canopy.scan',
  CANOPY_RESCAN: 'canopy.rescan',
  CANOPY_ERROR: 'canopy.error',

  // API operations
  API_SESSION_DELETE: 'api.session-delete',
  API_SESSION_COMPLETE: 'api.session-complete',

  // MCP
  MCP_EVENT: 'mcp.event',
  MCP_CALL: 'mcp.call',
  MCP_LIST: 'mcp.list',

  // Log retention
  LOG_RETENTION: 'log.retention',
  AGENT_RUN_RETENTION: 'agent_run.retention',
  NOTIFICATION_RETENTION: 'notification.retention',
  // Content claim system (Team Host WS2) — the publication-lock expiry sweep
  CONTENT_CLAIM_EXPIRY: 'content_claim.expiry',
  // Content claim system (Team Host WS2) — member-side materialization (§4)
  CONTENT_CLAIM_MATERIALIZE: 'content_claim.materialize',
  // Content claim system (Team Host WS2) — terminal-row retention prune
  CONTENT_CLAIM_PRUNE: 'content_claim.prune',
  // Content claim system (Team Host PR-1) — member disk-truth file-status route
  CONTENT_CLAIM_FILE_STATUS: 'content_claim.file_status',

  // Backup
  BACKUP_START: 'backup.start',
  BACKUP_COMPLETE: 'backup.complete',
  BACKUP_ERROR: 'backup.error',

  // Team sync
  TEAM_SYNC_START: 'team-sync.start',
  TEAM_SYNC_HANDOFF: 'team-sync.handoff',
  TEAM_SYNC_COMPLETE: 'team-sync.complete',
  TEAM_SYNC_ERROR: 'team-sync.error',
  TEAM_SYNC_REJECTED: 'team-sync.rejected',

  // Self-update / adopt orchestration. Emitted by the DETACHED orchestrator
  // process into a side-channel, then replayed into log_entries by the daemon
  // on its next startup (it cannot write the grove DB itself — it is restarting
  // the daemon that owns it). One kind keeps the adopt sequence filterable; the
  // message/metadata distinguish start / restart-attempt / health / outcome.
  UPGRADE_ADOPT: 'upgrade.adopt',

  // Release provenance
  RELEASE_PROVENANCE_RECONCILE: 'release-provenance.reconcile',

  // Symbionts
  MANAGED_FILES_RECONCILE: 'symbionts.managed-files-reconcile',
} as const;

export type LogKind = (typeof LOG_KINDS)[keyof typeof LOG_KINDS];

/**
 * Extract the component (first segment) from a kind string.
 * e.g., 'context.session' -> 'context'
 */
export function kindToComponent(kind: string): string {
  const dot = kind.indexOf('.');
  return dot > 0 ? kind.slice(0, dot) : kind;
}
