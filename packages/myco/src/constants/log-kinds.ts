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

  // Provider-level fetch instrumentation (cross-runtime: anything that
  // routes outbound LLM/embedding requests through `instrumentedFetch`).
  FETCH_START: 'fetch.start',
  FETCH_COMPLETE: 'fetch.complete',
  FETCH_TIMEOUT: 'fetch.timeout',
  FETCH_STALL: 'fetch.stall',
  FETCH_ABORT: 'fetch.abort',

  // Server (HTTP)
  SERVER_REQUEST: 'server.request',
  SERVER_STATIC: 'server.static',
  SERVER_ERROR: 'server.error',

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

  // Log retention
  LOG_RETENTION: 'log.retention',

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

  // Release provenance
  RELEASE_PROVENANCE_RECONCILE: 'release-provenance.reconcile',
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
