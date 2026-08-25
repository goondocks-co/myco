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
 * The step is guarded at BOTH ends, in the V2 idiom.
 *
 * The opening guard aborts when any existing credential carries a column the
 * backfill cannot place. `machine_id` decides the member — the grouping is
 * `mem_<machine_id>`, so a NULL would fuse every such row into one member,
 * permanently merging distinct humans, which #907 rule 3 forbids reconciling
 * afterwards. `lineage_root` and `lineage_started_at` are nullable at the source,
 * V3 having added them with ADD COLUMN, and NOT NULL at the target. Those rows
 * are also the ones the pipeline already refuses every write, so the guard fails
 * loudly rather than promoting dead credentials into a live identity.
 *
 * The closing guard aborts when the backfill placed fewer credentials than the
 * source holds. The insert is `OR IGNORE` so a re-run after a mid-step failure
 * is idempotent, and `OR IGNORE` cannot tell a duplicate from a constraint it
 * silently declined — a row dropped that way would leave `events.token_id`
 * dangling against a step that reported success. Counting is what makes the
 * difference visible without having to enumerate which constraint fired.
 *
 * BREAK-GLASS.md carries the repair for both.

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
 * `machine_claims` is what makes a machine identity belong to ONE member. Every
 * ownership predicate the ingest path applies keys on `machine_id`, not on
 * `member_id` — a continued session, prompt, plan or transcript may only be
 * written by the machine that owns it — so a member free to present any machine
 * identity it likes could append into another member's sessions in every Project
 * of the Deployment. A machine id is a label, not a secret: it appears in
 * `mem_<machine_id>` and in the owner's credential list.
 *
 * The claim is a PRIMARY KEY rather than a check the join performs, so two joins
 * racing for one identity resolve in the database and not in whoever reads first.
 * It is permanent: a machine id regenerates on reinstall or a home wipe, so a
 * genuinely new runtime brings a new identity to claim rather than needing this
 * one released.
 *
 * A revoked member's row is never deleted. `events.token_id` resolves through
 * `member_credentials` to `members`, so removing one would make the history it
 * wrote unattributable — revocation ends what a member can do, not the record of
 * what they did. Only `enrollment_authorities` has a retention sweep: nothing
 * resolves through a spent invitation.
 *
 * Every member may revoke any credential, so `revoked_by` records which one did —
 * a member id, or the owner acting through the dashboard under `owner:<id>`. The
 * two namespaces are told apart by prefix, or an operator reading the column
 * cannot answer which kind of actor ended the credential.
 * A destroy path that does not record its actor leaves denial-of-service by a
 * member indistinguishable from an operator's own action, and flat membership is
 * what puts that in reach of everyone rather than of one owner.
 *
 * The quota CHECK keeps the name `member_tokens_quota` verbatim. `classify()`
 * matches that literal to mark a quota violation terminal; renaming it turns a
 * terminal refusal into a 503 the member retries forever.
 */
const V5_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS _v5_guard_credential_backfillable`,
  `CREATE TABLE _v5_guard_credential_backfillable (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v5_guard_credential_backfillable (ok)
     SELECT CASE WHEN EXISTS (
       SELECT 1 FROM member_tokens
        WHERE machine_id IS NULL OR lineage_root IS NULL OR lineage_started_at IS NULL
     ) THEN 0 ELSE 1 END`,
  `DROP TABLE _v5_guard_credential_backfillable`,
  `CREATE TABLE IF NOT EXISTS members (
     id         TEXT PRIMARY KEY,
     label      TEXT,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS machine_claims (
     machine_id TEXT PRIMARY KEY,
     member_id  TEXT NOT NULL REFERENCES members(id),
     claimed_at INTEGER NOT NULL)`,
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
  `INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at)
     SELECT DISTINCT machine_id, 'mem_' || machine_id, 0 FROM member_tokens WHERE machine_id IS NOT NULL`,
  `INSERT OR IGNORE INTO member_credentials
     (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at,
      revoked_at, lineage_root, lineage_started_at, predecessor_id, first_used_at, bytes_written)
     SELECT t.id, 'mem_' || t.machine_id, t.token_hash, t.machine_id, NULL, NULL,
            t.lineage_started_at, t.expires_at,
            COALESCE(t.revoked_at, t.expires_at),
            t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at, t.bytes_written
       FROM member_tokens t WHERE t.machine_id IS NOT NULL`,
  `DROP TABLE IF EXISTS _v5_guard_backfill_complete`,
  `CREATE TABLE _v5_guard_backfill_complete (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v5_guard_backfill_complete (ok)
     SELECT CASE WHEN (SELECT COUNT(*) FROM member_credentials)
                    >= (SELECT COUNT(*) FROM member_tokens) THEN 1 ELSE 0 END`,
  `DROP TABLE _v5_guard_backfill_complete`,
];


/**
 * Deployment-held secrets (#961, approved). One row per named secret, holding
 * CIPHERTEXT only.
 *
 * The wrapping key never appears in this table — it is a platform binding. That
 * separation is the whole point: `BREAK-GLASS.md` prescribes direct store access
 * as the recovery path and #907 settled infrastructure control as proof of
 * authority, so store access is a deliberate, routine capability. Plaintext here
 * would make every break-glass operation and every leaked account token a
 * disclosure of every provider key at once.
 *
 * No masked preview is stored. A preview is a truncation of the plaintext, and
 * storing one would put the first and last characters of every credential back
 * into the table this design exists to keep them out of. `describe()` decrypts
 * and returns only the mask, so a preview is derived on demand and never rests.
 *
 * `key_version` is carried from the first row so re-wrapping under a new key is a
 * migration rather than an outage.
 */
const V6_STATEMENTS: readonly string[] = [
  /**
   * Deployment Settings, one row per leaf.
   *
   * Keyed by the leaf path the two-tier ledger names (§7.8), so a partial write
   * touches one row and carries its own actor — a whole-document write would make
   * every save look like a change to everything, and an audit trail that cannot
   * say which setting moved is not one.
   */
  `CREATE TABLE IF NOT EXISTS deployment_settings (
     leaf       TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL)`,
  /**
   * Per-Project capability admission.
   *
   * State rather than config: a Project is created by a member's first write
   * (`resolveProject`) and cannot have a settings file that predates it.
   *
   * ABSENCE MEANS DISABLED. This is the inverse of the member-side predicate,
   * where every master gate defaults true and a new project is made capture-only
   * by `reseedCaptureOnly()` writing `false` at provision. There is no equivalent
   * provisioning moment on a Deployment, so the default itself has to carry the
   * property. Any other default silently admits every Project that appears from
   * an ingest to every cost-bearing capability — the auto-adoption #428 exists
   * to prevent.
   */
  `CREATE TABLE IF NOT EXISTS project_capabilities (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     capability TEXT NOT NULL,
     enabled    INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     PRIMARY KEY (project_id, capability))`,
  /**
   * Step-up authorities (#907), for the operations flat membership does not cover.
   *
   * The same shape as an enrollment authority, and for the same reasons: 256 bits,
   * hashed at rest so the store never holds a replayable value, single-use through
   * one conditional update, expiring, and revocable.
   *
   * `purpose` binds an authority to the class of operation it is minted for. An
   * authority handed out to rotate a provider credential is not one that destroys a
   * Deployment: absent that binding, a member holding the first can perform the
   * second — a confused deputy, and a single token covering all four reads as
   * protection while granting every one of them.
   */
  `CREATE TABLE IF NOT EXISTS step_up_authorities (
     id          TEXT PRIMARY KEY,
     key_hash    TEXT NOT NULL,
     purpose     TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL,
     used_at     INTEGER,
     used_by     TEXT,
     revoked_at  INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_step_up_authorities_hash ON step_up_authorities (key_hash)`,
  `CREATE TABLE IF NOT EXISTS deployment_secrets (
     name        TEXT PRIMARY KEY,
     ciphertext  TEXT NOT NULL,
     iv          TEXT NOT NULL,
     key_version INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     updated_by  TEXT NOT NULL)`,
];

function withStamp(version: number, statements: readonly string[]): SchemaStep {
  return { version, statements: [...statements, `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${version}')`] };
}

/** Ordered schema steps; each step's last statement stamps its version. A database at version n receives steps n+1 and later. Step 2 opens with two guard tables, ahead of every ADD COLUMN so a repaired database re-applies the step whole: one CHECK fails when an existing project id is out of grammar, the other when a session has no machine identity and the token that minted it has none to backfill from. The step aborts on the guard's insert and the applier records nothing. Identity binding reads `machine_id`, so a session that kept a NULL refuses every later write to itself; BREAK-GLASS.md carries the repair. */
export const SCHEMA_STEPS: readonly SchemaStep[] = [withStamp(1, V1_STATEMENTS), withStamp(2, V2_STATEMENTS), withStamp(3, V3_STATEMENTS), withStamp(4, V4_STATEMENTS), withStamp(5, V5_STATEMENTS), withStamp(6, V6_STATEMENTS)];

/** Every statement of every step, in application order. */
export const SCHEMA_DDL: readonly string[] = SCHEMA_STEPS.flatMap((s) => s.statements);
