/**
 * DDL constants for all Myco vault tables, FTS5 virtual tables,
 * sync triggers, and secondary indexes.
 *
 * Extracted from schema.ts for readability -- these are pure string
 * constants with no runtime behaviour.
 */

// ---------------------------------------------------------------------------
// Table DDL statements
// ---------------------------------------------------------------------------

const SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

/** Ledger for one-time runtime migrations. See `daemon/migration-tasks.ts`. */
export const MIGRATION_TASKS_TABLE = `
  CREATE TABLE IF NOT EXISTS migration_tasks (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

// -- Capture Layer ----------------------------------------------------------

export const SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                     TEXT PRIMARY KEY,
    agent                  TEXT NOT NULL,
    "user"                 TEXT,
    project_root           TEXT,
    project_id             TEXT,
    branch                 TEXT,
    started_at             INTEGER NOT NULL,
    ended_at               INTEGER,
    status                 TEXT DEFAULT 'active',
    prompt_count           INTEGER DEFAULT 0,
    tool_count             INTEGER DEFAULT 0,
    title                  TEXT,
    summary                TEXT,
    transcript_path        TEXT,
    parent_session_id      TEXT,
    parent_session_reason  TEXT,
    processed              INTEGER DEFAULT 0,
    content_hash           TEXT,
    created_at             INTEGER NOT NULL,
    embedded               INTEGER DEFAULT 0,
    machine_id             TEXT NOT NULL DEFAULT 'local',
    synced_at              INTEGER,
    canopy_injections_offered      INTEGER,
    canopy_injection_total_tokens  INTEGER,
    canopy_skips_after_injection   INTEGER,
    canopy_reads_after_injection   INTEGER,
    canopy_tokens_saved            INTEGER,
    canopy_redundant_reads         INTEGER,
    canopy_map_tool_calls          INTEGER NOT NULL DEFAULT 0
  )`;

/**
 * Local-only deletion markers for sessions removed through
 * `deleteSessionCascade`. The buffer reconciler consults this table before
 * resurrecting a session row from a lingering buffer file: a tombstone means
 * the deletion was deliberate (user delete, maintenance sweep, invalid
 * capture) and the buffer must be discarded, not replayed.
 *
 * Deliberately absent from every team-sync registry
 * (TEAM_SYNC_OBSERVED_TABLES / TEAM_DELETE_TRIGGER_TABLES): tombstones gate
 * a strictly machine-local concern — this daemon's buffer files — and the
 * sessions delete itself already journals to team_outbox via its own
 * trigger. Rows age out via `pruneSessionTombstones`
 * (TOMBSTONE_RETENTION_MS), which outlives every buffer-retention window
 * so a buffer file can never survive its own tombstone.
 */
export const SESSION_TOMBSTONES_TABLE = `
  CREATE TABLE IF NOT EXISTS session_tombstones (
    session_id  TEXT PRIMARY KEY,
    project_id  TEXT,
    deleted_at  INTEGER NOT NULL,
    source      TEXT NOT NULL
  )`;

export const PROMPT_BATCHES_TABLE = `
  CREATE TABLE IF NOT EXISTS prompt_batches (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             TEXT,
    session_id             TEXT NOT NULL REFERENCES sessions(id),
    parent_prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    kind                   TEXT NOT NULL DEFAULT 'initial',
    origin                 TEXT NOT NULL DEFAULT 'human',
    prompt_number          INTEGER,
    user_prompt            TEXT,
    response_summary       TEXT,
    classification         TEXT,
    started_at             INTEGER,
    ended_at               INTEGER,
    status                 TEXT DEFAULT 'active',
    activity_count         INTEGER DEFAULT 0,
    processed              INTEGER DEFAULT 0,
    content_hash           TEXT,
    created_at             INTEGER NOT NULL,
    machine_id             TEXT NOT NULL DEFAULT 'local',
    synced_at              INTEGER
  )`;

export const KNOWLEDGE_GIT_PROVENANCE_TABLE = `
  CREATE TABLE IF NOT EXISTS knowledge_git_provenance (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id                 TEXT,
    machine_id                 TEXT NOT NULL DEFAULT 'local',
    identity_key               TEXT NOT NULL UNIQUE,
    session_id                 TEXT REFERENCES sessions(id),
    prompt_batch_id            INTEGER REFERENCES prompt_batches(id),
    capture_point              TEXT NOT NULL,
    captured_at                INTEGER NOT NULL,
    project_root               TEXT,
    branch                     TEXT,
    head_sha                   TEXT,
    upstream_ref               TEXT,
    upstream_sha               TEXT,
    production_ref             TEXT,
    production_sha             TEXT,
    is_dirty                   INTEGER NOT NULL DEFAULT 0,
    staged_count               INTEGER NOT NULL DEFAULT 0,
    unstaged_count             INTEGER NOT NULL DEFAULT 0,
    untracked_count            INTEGER NOT NULL DEFAULT 0,
    changed_paths_json         TEXT,
    tracked_blob_hashes_json   TEXT,
    patch_ids_json             TEXT,
    status_hash                TEXT NOT NULL,
    evidence_json              TEXT,
    error                      TEXT,
    created_at                 INTEGER NOT NULL
  )`;

export const KNOWLEDGE_RELEASE_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS knowledge_release_state (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id               TEXT,
    machine_id               TEXT NOT NULL DEFAULT 'local',
    identity_key             TEXT NOT NULL UNIQUE,
    namespace                TEXT NOT NULL,
    record_id                TEXT NOT NULL,
    source_session_id        TEXT REFERENCES sessions(id),
    source_prompt_batch_id   INTEGER REFERENCES prompt_batches(id),
    state                    TEXT NOT NULL,
    confidence               TEXT NOT NULL,
    basis_kind               TEXT,
    basis_ref                TEXT,
    basis_sha                TEXT,
    release_pr_number        INTEGER,
    reason                   TEXT,
    evidence_json            TEXT,
    checked_at               INTEGER NOT NULL,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER,
    synced_at                INTEGER
  )`;

export const ACTIVITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS activities (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           TEXT,
    session_id           TEXT NOT NULL REFERENCES sessions(id),
    prompt_batch_id      INTEGER NOT NULL REFERENCES prompt_batches(id),
    tool_name            TEXT NOT NULL,
    tool_input           TEXT,
    tool_output_summary  TEXT,
    file_path            TEXT,
    files_affected       TEXT,
    duration_ms          INTEGER,
    success              INTEGER DEFAULT 1,
    error_message        TEXT,
    timestamp            INTEGER NOT NULL,
    processed            INTEGER DEFAULT 0,
    content_hash         TEXT,
    created_at           INTEGER NOT NULL,
    canopy_injection_tokens INTEGER,
    myco_tool            TEXT,
    myco_op              TEXT
  )`;

const PLANS_TABLE = `
  CREATE TABLE IF NOT EXISTS plans (
    id               TEXT PRIMARY KEY,
    project_id       TEXT,
    logical_key      TEXT NOT NULL,
    status           TEXT DEFAULT 'active',
    author           TEXT,
    title            TEXT,
    content          TEXT,
    source_path      TEXT,
    tags             TEXT,
    session_id       TEXT REFERENCES sessions(id),
    prompt_batch_id  INTEGER REFERENCES prompt_batches(id),
    content_hash     TEXT,
    processed        INTEGER DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    embedded         INTEGER DEFAULT 0,
    machine_id       TEXT NOT NULL DEFAULT 'local',
    synced_at        INTEGER
  )`;

const ARTIFACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id               TEXT PRIMARY KEY,
    project_id       TEXT,
    artifact_type    TEXT,
    source_path      TEXT NOT NULL,
    title            TEXT NOT NULL,
    content          TEXT,
    last_captured_by TEXT,
    tags             TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    embedded         INTEGER DEFAULT 0,
    machine_id       TEXT NOT NULL DEFAULT 'local',
    synced_at        INTEGER
  )`;

const TEAM_MEMBERS_TABLE = `
  CREATE TABLE IF NOT EXISTS team_members (
    id          TEXT PRIMARY KEY,
    "user"      TEXT NOT NULL,
    role        TEXT,
    joined      TEXT,
    tags        TEXT,
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER
  )`;

const ATTACHMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS attachments (
    id              TEXT PRIMARY KEY,
    project_id      TEXT,
    session_id      TEXT REFERENCES sessions(id),
    prompt_batch_id INTEGER REFERENCES prompt_batches(id),
    file_path       TEXT NOT NULL,
    media_type      TEXT,
    description     TEXT,
    data            BLOB,
    content_hash    TEXT,
    created_at      INTEGER NOT NULL
  )`;

// -- Intelligence Layer -----------------------------------------------------

const AGENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agents (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    provider            TEXT,
    model               TEXT,
    system_prompt_hash  TEXT,
    config              TEXT,
    source              TEXT NOT NULL DEFAULT 'built-in',
    system_prompt       TEXT,
    max_turns           INTEGER,
    timeout_seconds     INTEGER,
    tool_access         TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER
  )`;

export const SPORES_TABLE = `
  CREATE TABLE IF NOT EXISTS spores (
    id                TEXT PRIMARY KEY,
    project_id        TEXT,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    session_id        TEXT REFERENCES sessions(id),
    prompt_batch_id   INTEGER REFERENCES prompt_batches(id),
    observation_type  TEXT NOT NULL,
    status            TEXT DEFAULT 'active',
    content           TEXT NOT NULL,
    context           TEXT,
    importance        INTEGER DEFAULT 5,
    file_path         TEXT,
    tags              TEXT,
    content_hash      TEXT,
    properties        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER,
    embedded          INTEGER DEFAULT 0,
    machine_id        TEXT NOT NULL DEFAULT 'local',
    synced_at         INTEGER
  )`;

export const ENTITIES_TABLE = `
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    properties  TEXT,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    status      TEXT DEFAULT 'active',
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER
  )`;

const GRAPH_EDGES_TABLE = `
  CREATE TABLE IF NOT EXISTS graph_edges (
    id              TEXT PRIMARY KEY,
    project_id      TEXT,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    source_id       TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    type            TEXT NOT NULL,
    session_id      TEXT,
    confidence      REAL DEFAULT 1.0,
    properties      TEXT,
    created_at      INTEGER NOT NULL,
    machine_id      TEXT NOT NULL DEFAULT 'local',
    synced_at       INTEGER
  )`;

const ENTITY_MENTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS entity_mentions (
    project_id  TEXT,
    entity_id   TEXT NOT NULL REFERENCES entities(id),
    note_id     TEXT NOT NULL,
    note_type   TEXT NOT NULL,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    synced_at   INTEGER,
    UNIQUE (entity_id, note_id, note_type, agent_id)
  )`;

const RESOLUTION_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS resolution_events (
    id            TEXT PRIMARY KEY,
    project_id    TEXT,
    agent_id      TEXT NOT NULL REFERENCES agents(id),
    spore_id      TEXT NOT NULL REFERENCES spores(id),
    action        TEXT NOT NULL,
    new_spore_id  TEXT,
    reason        TEXT,
    session_id    TEXT,
    created_at    INTEGER NOT NULL,
    machine_id    TEXT NOT NULL DEFAULT 'local',
    synced_at     INTEGER
  )`;

export const DIGEST_EXTRACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extracts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    tier            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    substrate_hash  TEXT,
    generated_at    INTEGER NOT NULL,
    machine_id      TEXT NOT NULL DEFAULT 'local',
    synced_at       INTEGER
  )`;

export const CORTEX_INSTRUCTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS cortex_instructions (
    id            TEXT NOT NULL,
    project_id    TEXT,
    agent_id      TEXT NOT NULL,
    content       TEXT NOT NULL,
    input_hash    TEXT NOT NULL,
    source_run_id TEXT,
    generated_at  INTEGER NOT NULL,
    machine_id    TEXT NOT NULL DEFAULT 'local',
    synced_at     INTEGER
  )`;

// -- Agent State Layer ------------------------------------------------------

const AGENT_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id             TEXT PRIMARY KEY,
    project_id     TEXT,
    agent_id       TEXT NOT NULL REFERENCES agents(id),
    task           TEXT,
    instruction    TEXT,
    status         TEXT DEFAULT 'pending',
    harness        TEXT,
    provider       TEXT,
    model          TEXT,
    session_ref    TEXT,
    resumable      INTEGER DEFAULT 0,
    resume_status  TEXT,
    resume_mode    TEXT,
    resumed_at     INTEGER,
    checkpoints    TEXT,
    usage_data     TEXT,
    started_at     INTEGER,
    completed_at   INTEGER,
    tokens_used    INTEGER,
    cost_usd       REAL,
    actual_cost_usd REAL,
    estimated_cost_usd REAL,
    cost_source    TEXT,
    cost_data      TEXT,
    actions_taken  TEXT,
    error          TEXT,
    dry_run        INTEGER NOT NULL DEFAULT 0,
    reasoning_level      TEXT,
    execution_overrides  TEXT,
    resume_attempts INTEGER NOT NULL DEFAULT 0,
    run_context    TEXT
  )`;

const AGENT_REPORTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT,
    run_id      TEXT NOT NULL REFERENCES agent_runs(id),
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    details     TEXT,
    created_at  INTEGER NOT NULL
  )`;

const AGENT_TURNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_turns (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           TEXT,
    run_id               TEXT NOT NULL REFERENCES agent_runs(id),
    agent_id             TEXT NOT NULL REFERENCES agents(id),
    turn_number          INTEGER NOT NULL,
    tool_name            TEXT NOT NULL,
    tool_input           TEXT,
    tool_output_summary  TEXT,
    started_at           INTEGER,
    completed_at         INTEGER
  )`;

const AGENT_TASKS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    source          TEXT NOT NULL DEFAULT 'built-in',
    display_name    TEXT,
    description     TEXT,
    prompt          TEXT NOT NULL,
    is_default      INTEGER DEFAULT 0,
    tool_overrides  TEXT,
    model           TEXT,
    config          TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER
  )`;

const AGENT_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    project_id  TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (agent_id, project_id, key)
  )`;

// -- Sync Layer -------------------------------------------------------------

export const TEAM_OUTBOX_TABLE = `
  CREATE TABLE IF NOT EXISTS team_outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    operation   TEXT NOT NULL DEFAULT 'upsert',
    payload     TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    team_id     TEXT,
    project_id  TEXT,
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER
  )`;

export const TEAM_SYNC_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS team_sync_state (
    rowid_guard INTEGER PRIMARY KEY CHECK (rowid_guard = 1),
    enabled     INTEGER NOT NULL DEFAULT 0
  )`;

/**
 * Per-grove reconciled projection of which projects belong to a team. One row
 * per syncable project. The live `syncRow` / `backfillRows` gates and the
 * membership-aware delete triggers read this so a non-member project's rows are
 * never enqueued. Local-only — never synced.
 */
export const TEAM_SYNC_MEMBERSHIP_TABLE = `
  CREATE TABLE IF NOT EXISTS team_sync_membership (
    project_id TEXT PRIMARY KEY,
    team_id    TEXT
  )`;

// -- Logging Layer ----------------------------------------------------------

export const LOG_ENTRIES_TABLE = `
  CREATE TABLE IF NOT EXISTS log_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT,
    timestamp   TEXT    NOT NULL,
    level       TEXT    NOT NULL,
    component   TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    data        TEXT,
    session_id  TEXT
  )`;

// -- Skills Layer -----------------------------------------------------------

export const SKILL_CANDIDATES_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_candidates (
    id              TEXT PRIMARY KEY,
    project_id      TEXT,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    machine_id      TEXT NOT NULL DEFAULT 'local',
    topic           TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'identified',
    source_ids      TEXT NOT NULL DEFAULT '[]',
    skill_id        TEXT,
    supersedes      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    approved_at     INTEGER,
    synced_at       INTEGER,
    evidence_bundle_id TEXT,
    quality_score   REAL,
    quality_failures TEXT NOT NULL DEFAULT '[]',
    coverage_matches TEXT NOT NULL DEFAULT '[]',
    last_reconciled_at INTEGER,
    reconciliation_reason TEXT
  )`;

export const SKILL_RECORDS_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_records (
    id              TEXT PRIMARY KEY,
    project_id      TEXT,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    machine_id      TEXT NOT NULL DEFAULT 'local',
    name            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    embedded        INTEGER DEFAULT 0,
    generation      INTEGER NOT NULL DEFAULT 1,
    candidate_id    TEXT REFERENCES skill_candidates(id),
    source_ids      TEXT NOT NULL DEFAULT '[]',
    path            TEXT NOT NULL,
    usage_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    properties      TEXT NOT NULL DEFAULT '{}',
    synced_at       INTEGER
  )`;

export const SKILL_LINEAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_lineage (
    id               TEXT PRIMARY KEY,
    project_id       TEXT,
    skill_id         TEXT NOT NULL REFERENCES skill_records(id),
    generation       INTEGER NOT NULL,
    action           TEXT NOT NULL,
    rationale        TEXT NOT NULL,
    source_ids_added TEXT NOT NULL DEFAULT '[]',
    content_snapshot TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    machine_id       TEXT NOT NULL DEFAULT 'local',
    synced_at        INTEGER
  )`;

// -- OKF wiki content (DB-resident; disk materialization is claim-scope) ----
//
// The wiki a synthesis run produces lives in these three tables. Revisions
// are the truth (full content snapshot per page-generation, mirroring
// skill_lineage.content_snapshot); okf_pages is the head pointer; an
// okf_generations row groups the page set one run produced so the wiki
// renders coherently "as of generation N". All three sync (id + machine_id +
// synced_at) — content must reach every team member's replica, unlike the
// skill_lineage precedent this design corrects. Single writer: OkfStore
// (packages/myco/src/okf/store.ts).

export const OKF_GENERATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS okf_generations (
    id           TEXT PRIMARY KEY,
    project_id   TEXT,
    machine_id   TEXT NOT NULL DEFAULT 'local',
    generation   INTEGER NOT NULL,
    run_id       TEXT,
    status       TEXT NOT NULL DEFAULT 'draft',
    plan         TEXT NOT NULL DEFAULT '{}',
    page_count   INTEGER NOT NULL DEFAULT 0,
    log_summary  TEXT NOT NULL DEFAULT '',
    inputs_hash  TEXT NOT NULL DEFAULT '',
    last_run_ref TEXT,
    findings     TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    synced_at    INTEGER
  )`;

export const OKF_PAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS okf_pages (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,
    machine_id  TEXT NOT NULL DEFAULT 'local',
    path        TEXT NOT NULL,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'active',
    generation  INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    synced_at   INTEGER
  )`;

export const OKF_PAGE_REVISIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS okf_page_revisions (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT,
    machine_id           TEXT NOT NULL DEFAULT 'local',
    page_id              TEXT NOT NULL REFERENCES okf_pages(id),
    page_generation      INTEGER NOT NULL,
    bundle_generation_id TEXT NOT NULL REFERENCES okf_generations(id),
    action               TEXT NOT NULL,
    rationale            TEXT NOT NULL DEFAULT '',
    frontmatter          TEXT NOT NULL DEFAULT '{}',
    body                 TEXT NOT NULL,
    created_at           INTEGER NOT NULL,
    synced_at            INTEGER
  )`;

export const SKILL_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS skill_usage (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,
    skill_id    TEXT NOT NULL REFERENCES skill_records(id),
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    machine_id  TEXT NOT NULL DEFAULT 'local',
    detected_at INTEGER NOT NULL
  )`;

// -- Myco tool-call usage (per-session, aggregated from activities) ---------
//
// Pre-aggregated per-session counts of every Myco tool call, derived from
// `activities` at Stop boundary by `materializeSessionMycoToolCalls`. Mirrors
// the materialization pattern used by Canopy aggregates (see
// `aggregateSessionCanopy` in db/queries/canopy.ts) — pure SQL over the
// authoritative activity log, no write-time counters at dispatch.
//
// `tool_name` stores the canonical Myco tool name (`myco_cortex`, `myco_search`,
// etc.); MCP-prefixed activity rows (`mcp__myco__myco_cortex`) are folded onto
// the canonical name by the aggregator so both code paths roll up together.
// `op` is the JSON `tool_input.op` dimension where present, '' otherwise — the
// empty string (not NULL) so the composite PK is stable.
export const SESSION_MYCO_TOOL_CALLS_TABLE = `
  CREATE TABLE IF NOT EXISTS session_myco_tool_calls (
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id   TEXT,
    tool_name    TEXT NOT NULL,
    op           TEXT NOT NULL DEFAULT '',
    count        INTEGER NOT NULL DEFAULT 0,
    computed_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_name, op)
  )`;

// -- Notifications Layer ----------------------------------------------------

export const NOTIFICATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    project_id  TEXT,
    domain      TEXT NOT NULL,
    type        TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'info',
    title       TEXT NOT NULL,
    message     TEXT,
    mode        TEXT NOT NULL DEFAULT 'banner',
    status      TEXT NOT NULL DEFAULT 'unread',
    link        TEXT,
    metadata    TEXT,
    created_at  INTEGER NOT NULL
  )`;

/**
 * Idempotency ledger for routed `/events` capture (residency design §4a). Under
 * Team Host, routed capture is at-least-once: the member both live-forwards AND
 * buffers every event, and the replay drain re-forwards on reconnect. The member
 * stamps each discrete `/events` event with a source-assigned, identity-bearing id
 * (`<machine_id>:<uuid>`); this ledger is the host's insert-if-not-exists key, so
 * live+drain double-delivery and lost-ack retries collapse to one prompt_batch /
 * activity row.
 *
 * `event_id` is the globally-unique identity-bearing id (PRIMARY KEY IS the dedup
 * constraint). `machine_id` records the originating member for origin-tracing.
 * `prompt_batch_id` is the batch a `user_prompt` event created, so a deduped
 * replay returns the SAME batch the live delivery opened (activities record NULL).
 * Host-local dedup state: deliberately NOT a team-sync table (see
 * `TEAM_SYNC_BACKFILL_TABLES`) — it never leaves the host.
 */
export const ROUTED_EVENT_DEDUP_TABLE = `
  CREATE TABLE IF NOT EXISTS routed_event_dedup (
    event_id        TEXT PRIMARY KEY,
    machine_id      TEXT,
    kind            TEXT NOT NULL,
    prompt_batch_id INTEGER,
    created_at      INTEGER NOT NULL
  )`;

// -- Content Claim System (Team Host WS2; grove-resident, NOT team-synced) --
//
// A content claim is a LOCK on a publishable artifact (a skill or an OKF wiki
// page) so exactly one team member's daemon materializes it into a working
// tree. Grove-resident and deliberately NOT a team-sync table (the
// `routed_event_dedup` pattern above): a lock needs a single transactional
// arbiter, and independent local DBs syncing offline could each insert an
// "active" claim and both survive reconciliation — the lock would fail
// exactly in the contention case it exists for. Members reach the
// authoritative rows over the serve surface instead; `machine_id` /
// `claimed_by` are origin-tracing only, kept for future per-node authz.

/**
 * `id` is `cclaim_<32hex>`. `artifact_kind`/`artifact_id`/`generation`
 * identify what is claimed (a `skill_records.id` at a
 * `skill_lineage.generation`, or an `okf_pages.id` at an
 * `okf_page_revisions.page_generation`). `claimed_by` is the claiming
 * machine_id — under v1 flat trust this is an unauthenticated identity, so
 * holder-only checks (release/refresh/mark-published) are cooperative, not
 * enforced; the ACTIVE-partial unique index below is the real serialization
 * guarantee. `expires_at` backstops an abandoned claim: TTL is the only
 * guarantee that a lock eventually frees (there is no reliable
 * release-on-detach). Terminal rows (released/published/expired) are audit
 * breadcrumbs pruned by GC after 30 days — content history lives in lineage,
 * not here. No `synced_at` column — not a synced table.
 */
export const CONTENT_CLAIMS_TABLE = `
  CREATE TABLE IF NOT EXISTS content_claims (
    id              TEXT PRIMARY KEY,
    artifact_kind   TEXT NOT NULL,
    artifact_id     TEXT NOT NULL,
    generation      INTEGER NOT NULL,
    project_id      TEXT NOT NULL,
    claimed_by      TEXT NOT NULL,
    claimed_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    state           TEXT NOT NULL,
    released_at     INTEGER,
    published_at    INTEGER,
    machine_id      TEXT NOT NULL
  )`;

/**
 * The ACTIVE-partial unique index IS the claim system's serialization
 * guarantee: claim creation is a constraint-based INSERT (never
 * SELECT-then-INSERT — that would be TOCTOU), so a second INSERT for the
 * same (artifact_kind, artifact_id) while a row is still 'active' hits this
 * constraint and the caller maps it to 409 `already_claimed`. Once the
 * holding row transitions off 'active' (released/published/expired), a new
 * active claim is free to insert.
 */
export const CONTENT_CLAIMS_ACTIVE_UNIQUE_INDEX =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_claims_active ON content_claims (artifact_kind, artifact_id) WHERE state = 'active'`;

/**
 * Durable "what was last published" marker — NEVER pruned (unlike
 * `content_claims`, whose terminal rows age out, which would resurrect
 * artifacts as "unpublished" if this table derived from claim history
 * instead of recording its own). Upserted by the mark-published operation;
 * absence of a row means the artifact has never been published. The
 * claimable inventory and "unpublished generation" badge compare
 * lineage-latest against `published_generation`. Grove-resident and NOT a
 * team-sync table, same posture as `content_claims`.
 */
export const CONTENT_PUBLICATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS content_publications (
    artifact_kind        TEXT NOT NULL,
    artifact_id          TEXT NOT NULL,
    published_generation INTEGER NOT NULL,
    published_at         INTEGER NOT NULL,
    published_by         TEXT NOT NULL,
    machine_id           TEXT NOT NULL,
    PRIMARY KEY (artifact_kind, artifact_id)
  )`;

// -- Eval Harness Layer -----------------------------------------------------

/**
 * Append-only log of every write a dry-run attempted. Each row captures the
 * tool that was called, the JSON-encoded arguments, the synthetic payload we
 * returned to the agent, and any stub id we minted for a synthetic resource.
 *
 * Append-only invariant: enforced at the query layer — no UPDATE or DELETE
 * helper is exposed. The ON DELETE CASCADE on `run_id` is intentional so a
 * future purge of `agent_runs` (e.g. retention job) also removes the
 * corresponding intents in a single atomic step. Rows must never be deleted
 * except as a side effect of a parent `agent_runs` delete.
 */
export const AGENT_RUN_WRITE_INTENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_run_write_intents (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id         TEXT,
    run_id             TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    phase_id           TEXT,
    tool_name          TEXT NOT NULL,
    tool_input         TEXT NOT NULL,
    synthetic_output   TEXT NOT NULL,
    stub_id            TEXT,
    classifier_verdict TEXT,
    classifier_reason  TEXT,
    recorded_at        INTEGER NOT NULL
  )`;

/**
 * Append-only lifecycle-event log for agent runs. Populated by
 * HarnessHooks (preToolUse/postToolUse/phaseStart/phaseEnd) via
 * buildAuditEventHooks() in agent/harness/audit-hooks.ts — this is the
 * durable event trail the daemon UI polls via GET
 * /api/agent/runs/:id/events for near-real-time activity feedback.
 * Closes Gap 4 from the April 2026 harness maturity audit
 * (spore_11b6645a205e0a455f247a122cddbb0d).
 *
 * No UPDATE/DELETE query helper is exposed at the query layer — same
 * append-only convention as agent_run_write_intents. ON DELETE CASCADE
 * on run_id lets a future agent_runs retention purge cascade.
 */
export const AGENT_RUN_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_run_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    TEXT,
    run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    phase_name    TEXT,
    event_type    TEXT NOT NULL,
    tool_name     TEXT,
    outcome       TEXT,
    duration_ms   INTEGER,
    payload       TEXT,
    recorded_at   INTEGER NOT NULL
  )`;

/**
 * Append-only history of digest_extracts rows. A new revision is inserted
 * every time a real (non-dry) run overwrites an existing digest. Rollback
 * restores an old revision and records a fresh revision to preserve the
 * append-only invariant.
 */
export const DIGEST_EXTRACT_REVISIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS digest_extract_revisions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          TEXT,
    agent_id            TEXT NOT NULL,
    tier                INTEGER NOT NULL,
    content             TEXT NOT NULL,
    metadata            TEXT,
    run_id              TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    parent_revision_id  INTEGER REFERENCES digest_extract_revisions(id),
    created_at          INTEGER NOT NULL
  )`;

export const MIGRATION_IMPORT_JOURNAL_TABLE = `
  CREATE TABLE IF NOT EXISTS migration_import_journal (
    id                   TEXT PRIMARY KEY,
    migration_id         TEXT NOT NULL,
    source_project_root  TEXT NOT NULL,
    source_db_path       TEXT NOT NULL,
    target_grove_id      TEXT NOT NULL,
    target_project_id    TEXT NOT NULL,
    source_table         TEXT NOT NULL,
    source_id            TEXT NOT NULL,
    target_table         TEXT NOT NULL,
    target_id            TEXT NOT NULL,
    source_machine_id    TEXT,
    target_machine_id    TEXT,
    import_origin        TEXT NOT NULL DEFAULT 'local',
    status               TEXT NOT NULL DEFAULT 'mapped',
    notes                TEXT,
    error                TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    UNIQUE (migration_id, source_db_path, source_table, source_id),
    UNIQUE (migration_id, target_grove_id, target_project_id, target_table, target_id)
  )`;

/**
 * Bounded audit log for the global-install migration walker.
 *
 * The walker visits every registered project on version-drift and during
 * the periodic detection tick to remove legacy per-project install
 * artifacts (`.agents/myco-run.cjs`, marker-bounded blocks in each
 * agent's project config). To keep this table small in steady state, we
 * only persist what matters for diagnostics:
 *
 *   - `kind = 'pass-summary'`: one row per walker pass with aggregate
 *     counts in `details`. Older summaries are pruned so the table
 *     holds at most one summary row per Grove DB.
 *   - `kind = 'error'`: one row per project that failed; retained for
 *     `myco doctor` to surface.
 *
 * Successful cleanups are never persisted — their absence is the
 * "everything ok" signal. The complete pass history would otherwise
 * accumulate one row per registered project per release, which is the
 * exact bloat that motivated keeping this table bounded by design.
 */
// `affected_project_id` (not `project_id`) on purpose — this audit log is
// daemon-level and walks projects across every Grove, so it isn't
// project-scope-filtered the way capture tables are. The
// GROVE_PROJECT_SCOPED_TABLES drift check insists that any `project_id`
// column belong to that registry, which we deliberately opt out of here.
export const MIGRATION_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS migration_log (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id              TEXT    NOT NULL,
    recorded_at          INTEGER NOT NULL,
    kind                 TEXT    NOT NULL CHECK (kind IN ('pass-summary', 'error')),
    affected_project_id  TEXT,
    project_root         TEXT,
    details              TEXT    NOT NULL
  )`;

export const CANOPY_ENTRIES_TABLE = `
  CREATE TABLE IF NOT EXISTS canopy_entries (
    project_id             TEXT    NOT NULL,
    machine_id             TEXT    NOT NULL DEFAULT 'local',
    path                   TEXT    NOT NULL,
    content_hash           TEXT    NOT NULL,
    size_bytes             INTEGER NOT NULL,
    token_estimate         INTEGER NOT NULL,
    line_count             INTEGER NOT NULL,
    language               TEXT,
    exports_json           TEXT,
    imports_json           TEXT,
    top_comment            TEXT,
    mechanical_updated_at  INTEGER NOT NULL,
    llm_description        TEXT,
    llm_updated_at         INTEGER,
    embedded               INTEGER DEFAULT 0,
    describe_attempts      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, path)
  ) WITHOUT ROWID`;

export const CANOPY_MAPS_TABLE = `
  CREATE TABLE IF NOT EXISTS canopy_maps (
    project_id           TEXT    NOT NULL,
    machine_id           TEXT    NOT NULL DEFAULT 'local',
    content              TEXT    NOT NULL,
    inputs_hash          TEXT    NOT NULL,
    generated_at         INTEGER NOT NULL,
    generated_by_run_id  TEXT,
    token_estimate       INTEGER NOT NULL,
    PRIMARY KEY (project_id, machine_id)
  ) WITHOUT ROWID`;

/**
 * Canopy aggregate column names + decls on the `sessions` table. Shared by
 * `SESSIONS_TABLE` (initial create), `migrateV24ToV25` (ALTER on existing
 * vaults), and the query-layer column lists / row interface.
 */
export const CANOPY_SESSION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['canopy_injections_offered', 'INTEGER'],
  ['canopy_injection_total_tokens', 'INTEGER'],
  ['canopy_skips_after_injection', 'INTEGER'],
  ['canopy_reads_after_injection', 'INTEGER'],
  ['canopy_tokens_saved', 'INTEGER'],
  ['canopy_redundant_reads', 'INTEGER'],
  ['canopy_map_tool_calls', 'INTEGER NOT NULL DEFAULT 0'],
];

/** Canopy column on the `activities` (tool-call) table. */
export const CANOPY_ACTIVITY_COLUMN: readonly [string, string] = [
  'canopy_injection_tokens',
  'INTEGER',
];

export const CANOPY_INDEX_DDLS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_canopy_hash ON canopy_entries (project_id, content_hash)',
  'CREATE INDEX IF NOT EXISTS idx_canopy_updated ON canopy_entries (project_id, mechanical_updated_at)',
];

export const MIGRATION_IMPORT_JOURNAL_INDEX_DDLS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_migration_import_journal_source ON migration_import_journal (migration_id, source_db_path, source_table, source_id)',
  'CREATE INDEX IF NOT EXISTS idx_migration_import_journal_target ON migration_import_journal (migration_id, target_grove_id, target_project_id, target_table, target_id)',
  'CREATE INDEX IF NOT EXISTS idx_migration_import_journal_project ON migration_import_journal (target_grove_id, target_project_id)',
  'CREATE INDEX IF NOT EXISTS idx_migration_import_journal_status ON migration_import_journal (migration_id, status)',
];

export const GROVE_PROJECT_SCOPED_TABLES = [
  'sessions',
  'prompt_batches',
  'knowledge_git_provenance',
  'knowledge_release_state',
  'activities',
  'plans',
  'artifacts',
  'attachments',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'digest_extracts',
  'cortex_instructions',
  'agent_runs',
  'agent_reports',
  'agent_turns',
  'agent_run_write_intents',
  'agent_run_events',
  'digest_extract_revisions',
  'skill_candidates',
  'skill_records',
  'skill_lineage',
  'skill_usage',
  'notifications',
  'log_entries',
  'agent_state',
  'canopy_entries',
  'canopy_maps',
  'session_myco_tool_calls',
  'session_tombstones',
  'okf_generations',
  'okf_pages',
  'okf_page_revisions',
  'content_claims',
] as const;

export const GROVE_PROJECT_SCOPE_INDEX_DDLS: readonly string[] =
  GROVE_PROJECT_SCOPED_TABLES.map(
    (table) => `CREATE INDEX IF NOT EXISTS idx_${table}_project_id ON ${table} (project_id)`,
  );

export const PLAN_LOGICAL_KEY_INDEX_DDLS: readonly string[] = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_legacy_logical_key ON plans (logical_key) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_project_logical_key ON plans (project_id, logical_key) WHERE project_id IS NOT NULL',
];

const PROJECT_SCOPED_CONTENT_HASH_TABLES = [
  'sessions',
  'prompt_batches',
  'activities',
  'spores',
] as const;

export const PROJECT_SCOPED_UNIQUE_INDEX_DDLS: readonly string[] = [
  ...PROJECT_SCOPED_CONTENT_HASH_TABLES.flatMap((table) => [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_legacy_content_hash ON ${table} (content_hash) WHERE project_id IS NULL AND content_hash IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_project_content_hash ON ${table} (project_id, content_hash) WHERE project_id IS NOT NULL AND content_hash IS NOT NULL`,
  ]),
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_legacy_identity ON entities (agent_id, type, name) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_project_identity ON entities (project_id, agent_id, type, name) WHERE project_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_extracts_legacy_agent_tier ON digest_extracts (agent_id, tier) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_extracts_project_agent_tier ON digest_extracts (project_id, agent_id, tier) WHERE project_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_records_legacy_name ON skill_records (name) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_records_project_name ON skill_records (project_id, name) WHERE project_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_instructions_legacy_id ON cortex_instructions (id) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_instructions_project_logical_id ON cortex_instructions (project_id, id) WHERE project_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_okf_pages_legacy_path ON okf_pages (path) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_okf_pages_project_path ON okf_pages (project_id, path) WHERE project_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_okf_generations_legacy_generation ON okf_generations (generation) WHERE project_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_okf_generations_project_generation ON okf_generations (project_id, generation) WHERE project_id IS NOT NULL',
];

/** Non-unique OKF query indexes — revision lookups by page and by generation. */
export const OKF_INDEX_DDLS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_okf_page_revisions_page ON okf_page_revisions (page_id, page_generation)',
  'CREATE INDEX IF NOT EXISTS idx_okf_page_revisions_bundle ON okf_page_revisions (bundle_generation_id)',
  'CREATE INDEX IF NOT EXISTS idx_okf_generations_status ON okf_generations (project_id, status)',
];

// -- FTS5 Virtual Tables ----------------------------------------------------

export const FTS_TABLES = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
     USING fts5(user_prompt, response_summary, content='prompt_batches', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts
     USING fts5(tool_name, tool_input, file_path, content='activities', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts
     USING fts5(message, content='log_entries', content_rowid='id')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS spores_fts
     USING fts5(content, content='spores', content_rowid='rowid')`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
     USING fts5(title, summary, content='sessions', content_rowid='rowid')`,

  // FTS5 sync triggers for log_entries (external-content table)
  `CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
     INSERT INTO log_entries_fts(rowid, message) VALUES (new.id, new.message);
   END`,

  `CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
     INSERT INTO log_entries_fts(log_entries_fts, rowid, message) VALUES('delete', old.id, old.message);
   END`,

  // FTS5 sync triggers for prompt_batches
  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ai AFTER INSERT ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_au AFTER UPDATE OF user_prompt, response_summary ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
     INSERT INTO prompt_batches_fts(rowid, user_prompt, response_summary) VALUES (new.id, new.user_prompt, new.response_summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS prompt_batches_fts_ad AFTER DELETE ON prompt_batches BEGIN
     INSERT INTO prompt_batches_fts(prompt_batches_fts, rowid, user_prompt, response_summary) VALUES('delete', old.id, old.user_prompt, old.response_summary);
   END`,

  // FTS5 sync triggers for activities
  `CREATE TRIGGER IF NOT EXISTS activities_fts_ai AFTER INSERT ON activities BEGIN
     INSERT INTO activities_fts(rowid, tool_name, tool_input, file_path) VALUES (new.id, new.tool_name, new.tool_input, new.file_path);
   END`,

  `CREATE TRIGGER IF NOT EXISTS activities_fts_au AFTER UPDATE OF tool_name, tool_input, file_path ON activities BEGIN
     INSERT INTO activities_fts(activities_fts, rowid, tool_name, tool_input, file_path) VALUES('delete', old.id, old.tool_name, old.tool_input, old.file_path);
     INSERT INTO activities_fts(rowid, tool_name, tool_input, file_path) VALUES (new.id, new.tool_name, new.tool_input, new.file_path);
   END`,

  `CREATE TRIGGER IF NOT EXISTS activities_fts_ad AFTER DELETE ON activities BEGIN
     INSERT INTO activities_fts(activities_fts, rowid, tool_name, tool_input, file_path) VALUES('delete', old.id, old.tool_name, old.tool_input, old.file_path);
   END`,

  // FTS5 sync triggers for spores
  `CREATE TRIGGER IF NOT EXISTS spores_fts_ai AFTER INSERT ON spores BEGIN
     INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,

  `CREATE TRIGGER IF NOT EXISTS spores_fts_au AFTER UPDATE OF content ON spores BEGIN
     INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
     INSERT INTO spores_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,

  `CREATE TRIGGER IF NOT EXISTS spores_fts_ad AFTER DELETE ON spores BEGIN
     INSERT INTO spores_fts(spores_fts, rowid, content) VALUES('delete', old.rowid, old.content);
   END`,

  // FTS5 sync triggers for sessions
  `CREATE TRIGGER IF NOT EXISTS sessions_fts_ai AFTER INSERT ON sessions BEGIN
     INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS sessions_fts_au AFTER UPDATE OF title, summary ON sessions BEGIN
     INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
     INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
   END`,

  `CREATE TRIGGER IF NOT EXISTS sessions_fts_ad AFTER DELETE ON sessions BEGIN
     INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES('delete', old.rowid, old.title, old.summary);
   END`,
];

// -- Team-sync delete triggers ----------------------------------------------

/**
 * Canonical set of tables that sync to the team cloud and are observed for
 * drift. Single source of truth — must match the worker's SYNCED_TABLES
 * (guarded by tests/db/synced-table-parity.test.ts). Defined here in the
 * dependency-free DDL module so both the query layer (team-outbox) and the
 * migration chain can import it WITHOUT dragging in db/client (bun:sqlite),
 * which would break the worker-CLI esbuild bundle.
 */
export const TEAM_SYNC_OBSERVED_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'skill_candidates',
  'skill_records',
  'skill_lineage',
  'skill_usage',
  'knowledge_release_state',
  'team_members',
  'okf_generations',
  'okf_pages',
  'okf_page_revisions',
] as const;

export type TeamSyncObservedTable = (typeof TEAM_SYNC_OBSERVED_TABLES)[number];

/**
 * Sync-protocol version each synced table first shipped in. Any per-table
 * request to the team worker (reconcile manifests, rebuilds) must skip
 * tables newer than the worker's advertised protocol — an older deployed
 * worker rejects unknown table names (400 "Unknown or ineligible table"),
 * and retrying them every cycle churns until the worker is redeployed.
 * Tables absent from this map predate versioned table additions (protocol 1).
 * Every SYNC_PROTOCOL_VERSION bump that adds tables MUST add them here
 * (see the version history on SYNC_PROTOCOL_VERSION in constants.ts).
 */
export const TABLE_MIN_SYNC_PROTOCOL: Readonly<Record<string, number>> = {
  skill_lineage: 3,
  okf_generations: 3,
  okf_pages: 3,
  okf_page_revisions: 3,
};

/** Minimum worker sync-protocol version required to reference `table`. */
export function tableMinSyncProtocol(table: string): number {
  return TABLE_MIN_SYNC_PROTOCOL[table] ?? 1;
}

/**
 * The subset of `tables` a worker at `workerProtocol` cannot serve (its
 * deployment predates them). Single source for BOTH the reconcile gate
 * (skip these tables this pass) and the Team status disclosure
 * (`reconcile_gated_tables`) — the behavior and what the UI reports come
 * from one computation and cannot drift. An unprobed worker (undefined /
 * null) gates nothing: reachability problems surface through the normal
 * per-partition error handling, not this filter.
 */
export function tablesGatedByWorkerProtocol(
  tables: readonly string[],
  workerProtocol: number | undefined | null,
): string[] {
  if (workerProtocol === undefined || workerProtocol === null) return [];
  return tables.filter((table) => tableMinSyncProtocol(table) > workerProtocol);
}

/**
 * Team-sync delete triggers — one per synced table.
 *
 * Auto-journal every local delete into `team_outbox` so the one-way push
 * to D1 mirrors deletions. Gated solely on stable team membership: the row's
 * project must be in `team_sync_membership`. The volatile
 * `team_sync_state.enabled` flag is deliberately NOT consulted — it is
 * auto-derived and transiently flips to 0 (e.g. the ~/.myco-team home-move
 * window), and a delete dropped during that window leaves no local trace, so
 * it would become a permanent D1 orphan. Membership is the stable signal
 * (kept from being wiped on a transient registry read), so a paused/transition
 * window delays a push but never loses a member's delete; push-side membership
 * gating still bounds what actually ships. Widens the FTS auto-sync-trigger
 * pattern above. `entity_mentions` is intentionally absent — no single `id`
 * column, never reaches D1.
 */
export const TEAM_DELETE_TRIGGER_TABLES = [
  'sessions', 'prompt_batches', 'spores', 'entities', 'graph_edges',
  'resolution_events', 'plans', 'artifacts', 'digest_extracts',
  'skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage',
  'knowledge_release_state', 'okf_generations', 'okf_pages', 'okf_page_revisions',
] as const;

export const TEAM_DELETE_TRIGGERS: readonly string[] = TEAM_DELETE_TRIGGER_TABLES.map(
  // Every table in TEAM_DELETE_TRIGGER_TABLES carries a `project_id` column
  // (verified against the CREATE TABLE DDL above), so `OLD.project_id` is
  // captured uniformly for per-row team routing. The json_object payload stays
  // id + machine_id — only the new `project_id` column matters for routing.
  (table) => `
  CREATE TRIGGER IF NOT EXISTS ${table}_team_ad
  AFTER DELETE ON ${table}
  WHEN OLD.project_id IN (SELECT project_id FROM team_sync_membership)
  BEGIN
    INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at)
    VALUES ('${table}', CAST(OLD.id AS TEXT), 'delete',
            json_object('id', OLD.id, 'machine_id', OLD.machine_id),
            OLD.machine_id,
            (SELECT team_id FROM team_sync_membership WHERE project_id = OLD.project_id),
            OLD.project_id,
            CAST(strftime('%s','now') AS INTEGER));
  END`,
);

// -- Indexes ----------------------------------------------------------------

export const SECONDARY_INDEXES = [
  // Sessions
  'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_processed ON sessions (processed)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at)',
  // v39 — supports getProjectActivitySeconds MAX(created_at) WHERE project_id = ?
  'CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions (project_id, created_at)',

  // Prompt batches
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_session_id ON prompt_batches (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_processed ON prompt_batches (processed)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_status ON prompt_batches (status)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_project_origin_created ON prompt_batches (project_id, origin, created_at)',
  // v39 — supports getProjectActivitySeconds without forcing the planner
  // to use the wider (project_id, origin, created_at) index.
  'CREATE INDEX IF NOT EXISTS idx_prompt_batches_project_created ON prompt_batches (project_id, created_at)',

  // Release provenance
  'CREATE INDEX IF NOT EXISTS idx_knowledge_git_provenance_project_captured ON knowledge_git_provenance (project_id, captured_at)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_git_provenance_session ON knowledge_git_provenance (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_git_provenance_prompt_batch ON knowledge_git_provenance (prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_git_provenance_head_sha ON knowledge_git_provenance (head_sha)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_git_provenance_status_hash ON knowledge_git_provenance (status_hash)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_project_checked ON knowledge_release_state (project_id, checked_at)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_record ON knowledge_release_state (namespace, record_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_state ON knowledge_release_state (state, confidence)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_session ON knowledge_release_state (source_session_id)',
  'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_prompt_batch ON knowledge_release_state (source_prompt_batch_id)',

  // Activities
  'CREATE INDEX IF NOT EXISTS idx_activities_session_id ON activities (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_prompt_batch_id ON activities (prompt_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_activities_tool_name ON activities (tool_name)',
  // Canopy aggregation skip-resolution: NOT EXISTS over (session_id, tool_name='Read').
  'CREATE INDEX IF NOT EXISTS idx_activities_session_tool ON activities (session_id, tool_name)',
  'CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_activities_processed ON activities (processed)',

  // Spores
  'CREATE INDEX IF NOT EXISTS idx_spores_agent_id ON spores (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_session_id ON spores (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_status ON spores (status)',
  'CREATE INDEX IF NOT EXISTS idx_spores_observation_type ON spores (observation_type)',
  'CREATE INDEX IF NOT EXISTS idx_spores_created_at ON spores (created_at)',

  // Entities
  'CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (type)',

  // Graph edges
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges (source_id, source_type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges (target_id, target_type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges (type)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_agent ON graph_edges (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_source_type ON graph_edges (source_id, type)',

  // Entity mentions
  'CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id ON entity_mentions (entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_entity_mentions_agent_id ON entity_mentions (agent_id)',

  // Resolution events
  'CREATE INDEX IF NOT EXISTS idx_resolution_events_spore_id ON resolution_events (spore_id)',
  'CREATE INDEX IF NOT EXISTS idx_resolution_events_agent_id ON resolution_events (agent_id)',

  // Digest extracts
  'CREATE INDEX IF NOT EXISTS idx_digest_extracts_agent_id ON digest_extracts (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_cortex_instructions_agent_id ON cortex_instructions (agent_id)',

  // Agent runs
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs (agent_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_completed ON agent_runs (task, status, completed_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_status_started_at ON agent_runs (task, status, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_resumable_task ON agent_runs (task, resumable, completed_at)',

  // Agent reports
  'CREATE INDEX IF NOT EXISTS idx_agent_reports_run_id ON agent_reports (run_id)',

  // Agent turns
  'CREATE INDEX IF NOT EXISTS idx_agent_turns_run_id ON agent_turns (run_id)',

  // Agent tasks
  'CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks (agent_id)',

  // Agent state
  'CREATE INDEX IF NOT EXISTS idx_agent_state_project ON agent_state (project_id, agent_id)',

  // Plans
  ...PLAN_LOGICAL_KEY_INDEX_DDLS,
  ...PROJECT_SCOPED_UNIQUE_INDEX_DDLS,
  ...OKF_INDEX_DDLS,
  'CREATE INDEX IF NOT EXISTS idx_plans_session_id ON plans (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_plans_source_path ON plans (source_path)',
  'CREATE INDEX IF NOT EXISTS idx_plans_content_hash ON plans (content_hash)',
  // Attachments
  'CREATE INDEX IF NOT EXISTS idx_attachments_file_path ON attachments (file_path)',

  // Team outbox
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_pending ON team_outbox (sent_at, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_table_name ON team_outbox (table_name)',
  'CREATE INDEX IF NOT EXISTS idx_team_outbox_row_lookup ON team_outbox (table_name, row_id)',

  // Machine ID (synced tables)
  'CREATE INDEX IF NOT EXISTS idx_sessions_machine_id ON sessions (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_spores_machine_id ON spores (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_graph_edges_machine_id ON graph_edges (machine_id)',

  // Skill candidates
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_id ON skill_candidates (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_machine_id ON skill_candidates (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_candidates_agent_status ON skill_candidates (agent_id, status)',

  // Skill records
  'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_id ON skill_records (agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_status ON skill_records (status)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records (name)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_machine_id ON skill_records (machine_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_records_agent_status ON skill_records (agent_id, status)',

  // Skill lineage
  'CREATE INDEX IF NOT EXISTS idx_skill_lineage_skill_id ON skill_lineage (skill_id)',

  // Skill usage
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_id ON skill_usage (skill_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_session_id ON skill_usage (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_session ON skill_usage (skill_id, session_id)',

  // Session Myco tool calls (aggregated per session/tool/op at Stop)
  'CREATE INDEX IF NOT EXISTS idx_session_myco_tool_calls_tool ON session_myco_tool_calls (tool_name, op)',

  // Log entries
  'CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries (level)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_component ON log_entries (component)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_kind ON log_entries (kind)',
  'CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries (session_id)',

  // Notifications
  'CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_domain ON notifications (domain)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at)',
  'CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications (status, created_at)',

  // Content claims
  CONTENT_CLAIMS_ACTIVE_UNIQUE_INDEX,

  // Eval harness
  'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id ON agent_run_write_intents (run_id)',
  'CREATE INDEX IF NOT EXISTS idx_write_intents_run_id_tool ON agent_run_write_intents (run_id, tool_name)',
  'CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id ON agent_run_events (run_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_digest_revisions_agent_tier ON digest_extract_revisions (agent_id, tier, created_at DESC)',

  // Grove migration import journal
  ...MIGRATION_IMPORT_JOURNAL_INDEX_DDLS,

  // Grove project-scoped row filters
  ...GROVE_PROJECT_SCOPE_INDEX_DDLS,

  // Canopy
  ...CANOPY_INDEX_DDLS,
];

// -- Ordered table creation -------------------------------------------------

export const TABLE_DDLS = [
  SCHEMA_VERSION_TABLE,
  MIGRATION_TASKS_TABLE,
  // Capture layer (order matters for FK references)
  SESSIONS_TABLE,
  SESSION_TOMBSTONES_TABLE,
  PROMPT_BATCHES_TABLE,
  KNOWLEDGE_GIT_PROVENANCE_TABLE,
  KNOWLEDGE_RELEASE_STATE_TABLE,
  ACTIVITIES_TABLE,
  PLANS_TABLE,
  ARTIFACTS_TABLE,
  TEAM_MEMBERS_TABLE,
  ATTACHMENTS_TABLE,
  // Intelligence layer
  AGENTS_TABLE,
  SPORES_TABLE,
  ENTITIES_TABLE,
  GRAPH_EDGES_TABLE,
  ENTITY_MENTIONS_TABLE,
  RESOLUTION_EVENTS_TABLE,
  DIGEST_EXTRACTS_TABLE,
  CORTEX_INSTRUCTIONS_TABLE,
  // Agent state layer
  AGENT_RUNS_TABLE,
  AGENT_REPORTS_TABLE,
  AGENT_TURNS_TABLE,
  AGENT_TASKS_TABLE,
  AGENT_STATE_TABLE,
  // Skills layer
  SKILL_CANDIDATES_TABLE,
  SKILL_RECORDS_TABLE,
  SKILL_LINEAGE_TABLE,
  SKILL_USAGE_TABLE,
  // OKF wiki layer (DB-resident content; single writer OkfStore)
  OKF_GENERATIONS_TABLE,
  OKF_PAGES_TABLE,
  OKF_PAGE_REVISIONS_TABLE,
  // Per-session Myco tool usage (aggregated from activities at Stop)
  SESSION_MYCO_TOOL_CALLS_TABLE,
  // Sync layer
  TEAM_OUTBOX_TABLE,
  TEAM_SYNC_STATE_TABLE,
  TEAM_SYNC_MEMBERSHIP_TABLE,
  // Logging layer
  LOG_ENTRIES_TABLE,
  // Notifications layer
  NOTIFICATIONS_TABLE,
  // Routed-capture idempotency ledger (Team Host §4a)
  ROUTED_EVENT_DEDUP_TABLE,
  // Content claim system (Team Host WS2; grove-resident, not team-synced)
  CONTENT_CLAIMS_TABLE,
  CONTENT_PUBLICATIONS_TABLE,
  // Eval harness layer
  AGENT_RUN_WRITE_INTENTS_TABLE,
  AGENT_RUN_EVENTS_TABLE,
  DIGEST_EXTRACT_REVISIONS_TABLE,
  MIGRATION_IMPORT_JOURNAL_TABLE,
  MIGRATION_LOG_TABLE,
  // Canopy layer
  CANOPY_ENTRIES_TABLE,
  CANOPY_MAPS_TABLE,
];
