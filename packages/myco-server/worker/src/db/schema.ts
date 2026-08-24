import { MEMBER_TOKEN_BYTE_QUOTA } from '../constants.js';
import { MEMBER_TOKEN_TTL_MS } from '../auth/tokens.js';

/** The project-id grammar as SQL over a column expression: one to sixty-four characters from `[A-Za-z0-9._-]`. */
export const projectIdGrammar = (column: string): string => `${column} NOT GLOB '*[^A-Za-z0-9._-]*' AND length(${column}) BETWEEN 1 AND 64 AND ${column} NOT IN ('.', '..')`;
export const PROJECT_ID_GRAMMAR = projectIdGrammar('project_id');

export interface SchemaStep {
  version: number;
  statements: readonly string[];
}

/** Rows written by ingest under a project; every primary key and index leads with project_id. */
const V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (
     project_id TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_tokens (
     id            TEXT PRIMARY KEY,
     project_id    TEXT NOT NULL REFERENCES projects(project_id),
     machine_id    TEXT,
     token_hash    TEXT NOT NULL,
     expires_at    INTEGER NOT NULL,
     revoked_at    INTEGER,
     bytes_written INTEGER NOT NULL DEFAULT 0,
     CONSTRAINT member_tokens_quota CHECK (bytes_written <= ${MEMBER_TOKEN_BYTE_QUOTA}))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_member_tokens_hash ON member_tokens (token_hash)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     project_id          TEXT NOT NULL,
     session_id          TEXT NOT NULL,
     machine_id          TEXT,
     created_by_token_id TEXT NOT NULL,
     first_received_at   INTEGER NOT NULL,
     last_received_at    INTEGER NOT NULL,
     PRIMARY KEY (project_id, session_id))`,
  `CREATE TABLE IF NOT EXISTS events (
     project_id    TEXT NOT NULL,
     event_id      TEXT NOT NULL,
     session_id    TEXT NOT NULL,
     token_id      TEXT NOT NULL,
     kind          TEXT NOT NULL,
     channel       TEXT NOT NULL,
     payload       TEXT NOT NULL,
     envelope_hash TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     received_at   INTEGER NOT NULL,
     PRIMARY KEY (project_id, event_id))`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events (project_id, session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_token ON events (project_id, token_id, created_at)`,
];

/** Schema v2: a guard that aborts the step when a v1 project id is out of grammar, producer identity and spill key on events, session facts and the event that settled them, the typed projections, blobs, transcripts, tags, an index for every column a projection filters on, the project-id grammar enforced on the v1 projects table by triggers (a rebuild is not expand-only) and as a CHECK on every v2 table, and the backfill of v1 session machine ids from their minting token. */
const V2_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS _v2_guard_project_id_grammar`,
  `CREATE TABLE _v2_guard_project_id_grammar (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v2_guard_project_id_grammar (ok)
     SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE NOT (${PROJECT_ID_GRAMMAR})) THEN 0 ELSE 1 END`,
  `DROP TABLE _v2_guard_project_id_grammar`,
  `DROP TABLE IF EXISTS _v2_guard_session_machine_id`,
  `CREATE TABLE _v2_guard_session_machine_id (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v2_guard_session_machine_id (ok)
     SELECT CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.machine_id IS NULL
              AND (SELECT machine_id FROM member_tokens WHERE id = s.created_by_token_id) IS NULL) THEN 0 ELSE 1 END`,
  `DROP TABLE _v2_guard_session_machine_id`,
  `CREATE TRIGGER IF NOT EXISTS projects_grammar_insert BEFORE INSERT ON projects
     WHEN NOT (${projectIdGrammar('NEW.project_id')})
     BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: projects_grammar'); END`,
  `CREATE TRIGGER IF NOT EXISTS projects_grammar_update BEFORE UPDATE OF project_id ON projects
     WHEN NOT (${projectIdGrammar('NEW.project_id')})
     BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: projects_grammar'); END`,
  `ALTER TABLE events ADD COLUMN producer_adapter TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE events ADD COLUMN producer_version TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE events ADD COLUMN blob_key TEXT`,
  `ALTER TABLE events ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE events ADD COLUMN ingest_nonce TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE sessions ADD COLUMN agent TEXT`,
  `ALTER TABLE sessions ADD COLUMN branch TEXT`,
  `ALTER TABLE sessions ADD COLUMN started_at INTEGER`,
  `ALTER TABLE sessions ADD COLUMN ended_at INTEGER`,
  `ALTER TABLE sessions ADD COLUMN origin_path TEXT`,
  `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN parent_reason TEXT`,
  `ALTER TABLE sessions ADD COLUMN facts_event_id TEXT`,
  `CREATE TABLE IF NOT EXISTS blobs (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     key         TEXT NOT NULL,
     size        INTEGER NOT NULL,
     media_type  TEXT NOT NULL,
     token_id    TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, key))`,
  `CREATE INDEX IF NOT EXISTS idx_blobs_token ON blobs (project_id, token_id)`,
  `CREATE TABLE IF NOT EXISTS blob_reservations (
     reservation_id TEXT PRIMARY KEY,
     project_id     TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     key            TEXT NOT NULL,
     token_id       TEXT NOT NULL,
     size           INTEGER NOT NULL,
     expires_at     INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_blob_reservations_token ON blob_reservations (project_id, token_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS prompt_batches (
     project_id       TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     prompt_id        TEXT NOT NULL,
     session_id       TEXT NOT NULL,
     event_id         TEXT NOT NULL,
     parent_prompt_id TEXT,
     thread_id        TEXT,
     thread_label     TEXT,
     origin           TEXT NOT NULL,
     prompt_kind      TEXT,
     text             TEXT,
     blob_key         TEXT,
     content_hash     TEXT NOT NULL,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL,
     ended_at         INTEGER,
     token_id         TEXT NOT NULL,
     received_at      INTEGER NOT NULL,
     PRIMARY KEY (project_id, prompt_id))`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_session ON prompt_batches (project_id, session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
     project_id              TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     tool_call_id            TEXT NOT NULL,
     session_id              TEXT NOT NULL,
     prompt_id               TEXT,
     event_id                TEXT NOT NULL,
     tool_name               TEXT NOT NULL,
     myco_tool               TEXT,
     myco_op                 TEXT,
     input                   TEXT,
     input_blob_key          TEXT,
     output_preview          TEXT,
     output_blob_key         TEXT,
     success                 INTEGER NOT NULL,
     error_message           TEXT,
     duration_ms             INTEGER,
     files_affected          TEXT,
     canopy_injection_tokens INTEGER,
     created_at              INTEGER NOT NULL,
     token_id                TEXT NOT NULL,
     received_at             INTEGER NOT NULL,
     PRIMARY KEY (project_id, tool_call_id))`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (project_id, session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls (project_id, tool_name, created_at)`,
  `CREATE TABLE IF NOT EXISTS responses (
     project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     response_id  TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     prompt_id    TEXT,
     event_id     TEXT NOT NULL,
     text         TEXT,
     blob_key     TEXT,
     content_hash TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     token_id     TEXT NOT NULL,
     received_at  INTEGER NOT NULL,
     PRIMARY KEY (project_id, response_id))`,
  `CREATE INDEX IF NOT EXISTS idx_responses_session ON responses (project_id, session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_prompt ON responses (project_id, prompt_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS plans (
     project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     plan_key     TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     event_id     TEXT NOT NULL,
     machine_id   TEXT NOT NULL,
     title        TEXT,
     content      TEXT,
     blob_key     TEXT,
     content_hash TEXT NOT NULL,
     status       TEXT NOT NULL,
     origin_path  TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL,
     token_id     TEXT NOT NULL,
     received_at  INTEGER NOT NULL,
     PRIMARY KEY (project_id, plan_key))`,
  `CREATE INDEX IF NOT EXISTS idx_plans_session ON plans (project_id, session_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
     project_id    TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     attachment_id TEXT NOT NULL,
     session_id    TEXT NOT NULL,
     prompt_id     TEXT,
     event_id      TEXT NOT NULL,
     blob_key      TEXT NOT NULL,
     media_type    TEXT NOT NULL,
     byte_size     INTEGER NOT NULL,
     description   TEXT,
     origin_path   TEXT,
     created_at    INTEGER NOT NULL,
     token_id      TEXT NOT NULL,
     received_at   INTEGER NOT NULL,
     PRIMARY KEY (project_id, attachment_id))`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments (project_id, session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS transcripts (
     project_id        TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     transcript_id     TEXT NOT NULL,
     session_id        TEXT NOT NULL,
     machine_id        TEXT NOT NULL,
     agent             TEXT,
     origin_path       TEXT,
     size              INTEGER NOT NULL DEFAULT 0,
     segment_count     INTEGER NOT NULL DEFAULT 0,
     first_received_at INTEGER NOT NULL,
     last_received_at  INTEGER NOT NULL,
     token_id          TEXT NOT NULL,
     PRIMARY KEY (project_id, transcript_id))`,
  `CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts (project_id, session_id)`,
  `CREATE TABLE IF NOT EXISTS transcript_segments (
     project_id    TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     transcript_id TEXT NOT NULL,
     base_offset   INTEGER NOT NULL,
     length        INTEGER NOT NULL,
     blob_key      TEXT NOT NULL,
     event_id      TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     received_at   INTEGER NOT NULL,
     token_id      TEXT NOT NULL,
     PRIMARY KEY (project_id, transcript_id, base_offset))`,
  `CREATE TABLE IF NOT EXISTS tags (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     entity_kind TEXT NOT NULL,
     entity_id   TEXT NOT NULL,
     tag         TEXT NOT NULL,
     PRIMARY KEY (project_id, entity_kind, entity_id, tag))`,
  `CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags (project_id, tag)`,
  `UPDATE sessions SET machine_id = (SELECT machine_id FROM member_tokens WHERE id = sessions.created_by_token_id)
     WHERE machine_id IS NULL`,
];

/** Schema v3: token lineage on `member_tokens` — the predecessor a token succeeded, the root and start of its chain, and the instant of its first authenticated use — with an index over the root for lineage revocation and a partial unique index holding one live successor per predecessor; every existing row is its own root and its lineage started one TTL before it expires. */
const V3_STATEMENTS: readonly string[] = [
  `ALTER TABLE member_tokens ADD COLUMN predecessor_id TEXT`,
  `ALTER TABLE member_tokens ADD COLUMN lineage_root TEXT`,
  `ALTER TABLE member_tokens ADD COLUMN lineage_started_at INTEGER`,
  `ALTER TABLE member_tokens ADD COLUMN first_used_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_member_tokens_lineage ON member_tokens (lineage_root)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_member_tokens_live_successor ON member_tokens (predecessor_id) WHERE revoked_at IS NULL`,
  `UPDATE member_tokens SET lineage_root = id WHERE lineage_root IS NULL`,
  `UPDATE member_tokens SET lineage_started_at = expires_at - ${MEMBER_TOKEN_TTL_MS} WHERE lineage_started_at IS NULL`,
];

/** Schema v4: the ordered path a project's session list reads — sessions carry only their primary key `(project_id, session_id)`, so "newest first" had no index before the read API existed. The key is `first_received_at`, which stays with the first writer: a keyset page over `last_received_at` would skip any session an ingest moves above the cursor between two pages. */
const V4_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_recent ON sessions (project_id, first_received_at)`,
];

/**
 * Flat membership (#912, model approved in #907). A credential belongs to a
 * MEMBER and a Deployment, not to a project: `project_id` leaves the credential
 * and project scope is resolved per request.
 *
 * The step opens with a guard, in the V2 idiom, that aborts when any existing
 * credential has no machine identity. Backfill groups credentials into members
 * by `machine_id`, so a NULL would fuse every such row into one member row —
 * distinct humans permanently merged, which #907 rule 3 forbids reconciling
 * afterwards. Those rows are also the ones the pipeline already refuses every
 * write, so the guard fails loudly rather than promoting dead credentials into
 * a live identity. BREAK-GLASS.md carries the repair.

 * `machine_id` stays nullable past the guard. The guard is a precondition on
 * the BACKFILL — it derives the member grouping from machine identity and has
 * nothing to derive from when the column is NULL. Credentials issued after it
 * take their member from enrollment instead, so the derivation no longer
 * applies, and the pipeline keeps refusing a credential with no machine
 * identity as `no_machine_identity`. A NOT NULL here would make that refusal
 * unreachable while the member, telemetry and both-target contract still carry
 * the code, leaving a refusal no gate could ever exercise.
 *
 * Backfilled credentials are written REVOKED. Preserving a live `token_hash`
 * would let an existing bearer keep authenticating while silently gaining
 * Deployment-wide authority beyond the one project it is pinned to — the silent
 * escalation #912's acceptance forbids. Re-join is the migration path.
 * Attribution history is preserved untouched: `events.token_id` and its
 * siblings continue to resolve, now through `member_credentials`.
 *
 * A revoked member's row is never deleted. `events.token_id` resolves through
 * `member_credentials` to `members`, so removing one would make the history it
 * wrote unattributable — revocation ends what a member can do, not the record of
 * what they did. Only `enrollment_authorities` has a retention sweep: nothing
 * resolves through a spent invitation.
 *
 * Every member may revoke any credential, so `revoked_by` records which one did.
 * A destroy path that does not record its actor leaves denial-of-service by a
 * member indistinguishable from an operator's own action, and flat membership is
 * what puts that in reach of everyone rather than of one owner.
 *
 * The quota CHECK keeps the name `member_tokens_quota` verbatim. `classify()`
 * matches that literal to mark a quota violation terminal; renaming it turns a
 * terminal refusal into a 503 the member retries forever.
 */
const V5_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS _v5_guard_credential_machine_id`,
  `CREATE TABLE _v5_guard_credential_machine_id (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v5_guard_credential_machine_id (ok)
     SELECT CASE WHEN EXISTS (SELECT 1 FROM member_tokens WHERE machine_id IS NULL) THEN 0 ELSE 1 END`,
  `DROP TABLE _v5_guard_credential_machine_id`,
  `CREATE TABLE IF NOT EXISTS members (
     id         TEXT PRIMARY KEY,
     label      TEXT,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS enrollment_authorities (
     id                TEXT PRIMARY KEY,
     key_hash          TEXT NOT NULL,
     created_at        INTEGER NOT NULL,
     expires_at        INTEGER NOT NULL,
     used_at           INTEGER,
     used_by_runtime   TEXT,
     revoked_at        INTEGER,
     created_by_member TEXT,
     member_id         TEXT REFERENCES members(id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_authorities_hash ON enrollment_authorities (key_hash)`,
  `CREATE TABLE IF NOT EXISTS member_credentials (
     id                 TEXT PRIMARY KEY,
     member_id          TEXT NOT NULL REFERENCES members(id),
     token_hash         TEXT NOT NULL,
     machine_id         TEXT,
     runtime_label      TEXT,
     runtime_kind       TEXT,
     issued_at          INTEGER NOT NULL,
     expires_at         INTEGER NOT NULL,
     revoked_at         INTEGER,
     lineage_root       TEXT NOT NULL,
     lineage_started_at INTEGER NOT NULL,
     predecessor_id     TEXT,
     first_used_at      INTEGER,
     bytes_written      INTEGER NOT NULL DEFAULT 0,
     revoked_by         TEXT,
     CONSTRAINT member_tokens_quota CHECK (bytes_written <= ${MEMBER_TOKEN_BYTE_QUOTA}))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_member_credentials_hash ON member_credentials (token_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_member_credentials_live_successor
     ON member_credentials (predecessor_id) WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_member_credentials_lineage ON member_credentials (lineage_root)`,
  `CREATE INDEX IF NOT EXISTS idx_blob_reservations_credential ON blob_reservations (token_id, expires_at)`,
  `INSERT OR IGNORE INTO members (id, label, created_at, revoked_at)
     SELECT DISTINCT 'mem_' || machine_id, machine_id, 0, NULL FROM member_tokens WHERE machine_id IS NOT NULL`,
  `INSERT OR IGNORE INTO member_credentials
     (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at,
      revoked_at, lineage_root, lineage_started_at, predecessor_id, first_used_at, bytes_written)
     SELECT t.id, 'mem_' || t.machine_id, t.token_hash, t.machine_id, NULL, NULL,
            t.lineage_started_at, t.expires_at,
            COALESCE(t.revoked_at, t.expires_at),
            t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at, t.bytes_written
       FROM member_tokens t WHERE t.machine_id IS NOT NULL`,
];

function withStamp(version: number, statements: readonly string[]): SchemaStep {
  return { version, statements: [...statements, `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${version}')`] };
}

/** Ordered schema steps; each step's last statement stamps its version. A database at version n receives steps n+1 and later. Step 2 opens with two guard tables, ahead of every ADD COLUMN so a repaired database re-applies the step whole: one CHECK fails when an existing project id is out of grammar, the other when a session has no machine identity and the token that minted it has none to backfill from. The step aborts on the guard's insert and the applier records nothing. Identity binding reads `machine_id`, so a session that kept a NULL refuses every later write to itself; BREAK-GLASS.md carries the repair. */
export const SCHEMA_STEPS: readonly SchemaStep[] = [withStamp(1, V1_STATEMENTS), withStamp(2, V2_STATEMENTS), withStamp(3, V3_STATEMENTS), withStamp(4, V4_STATEMENTS), withStamp(5, V5_STATEMENTS)];

/** Every statement of every step, in application order. */
export const SCHEMA_DDL: readonly string[] = SCHEMA_STEPS.flatMap((s) => s.statements);
