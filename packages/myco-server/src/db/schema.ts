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
 * Every member may revoke any credential, so `revoked_by` records which one did,
 * by member id, on whichever channel the revocation arrived.
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
 * `key_version` is carried from the first row so a later re-wrap can identify which
 * rows are sealed under which key. It does not by itself make rotation
 * non-disruptive: nothing resolves a version back to key material today, so a
 * rotated wrapping key leaves every row unreadable until its credential is
 * re-entered. A slot in that state reports `readable: false` rather than failing
 * the whole surface, so an operator can see what to re-enter. #964 owns rotation.
 */
/**
 * Retention across step 6, stated once rather than per table: three of the four
 * deliberately have none.
 *
 * `deployment_settings`, `project_capabilities` and `deployment_secrets` each hold
 * CURRENT STATE — one row per leaf, per admission, per credential slot. A row is
 * the setting, so pruning one deletes the setting. Their audit lives on the row
 * itself as `updated_by`/`updated_at` rather than in a growing log, which is what
 * makes them bounded by the number of settings rather than by time. No project
 * deletion exists, so no orphan accumulates behind a removed Project either.
 *
 * `step_up_authorities` grew once per mint and its spend path swept finished
 * rows; dormant as of 2026-08-30 (#1036), nothing writes or reads it. The
 * operation an old row authorised keeps its own record on the row it changed.
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
  // Dormant as of 2026-08-30 (#1036): the step-up mechanism left the product and
  // nothing writes or reads these rows. The table stays in the chain — steps are
  // expand-only — and in databases, inert.
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


/**
 * Schema v7: the intelligence tables the agent runtime reads and writes.
 *
 * Translated from the 1.4 vault schema (`packages/myco/src/db/schema-ddl.ts`)
 * rather than copied. Three properties of the local vault are wrong on a
 * Deployment that holds many Projects for many members:
 *
 * 1. `project_id` is nullable in sixteen of these tables locally. Here it is NOT
 *    NULL under the grammar CHECK, and every primary key and index leads with it.
 *    A nullable tenancy column is a row belonging to no Project.
 * 2. Ten of them carry `machine_id` / `synced_at` / `received_at`, which are Team
 *    Host sync columns. Team Host is retired, and attribution on a Deployment is
 *    per member, runtime and agent — a narrower thing carried by the run and the
 *    credential, not by a machine name on every row.
 * The six append-only log tables KEEP `INTEGER PRIMARY KEY AUTOINCREMENT`, which
 * SQLite requires to be the whole primary key and so cannot lead with
 * `project_id`. That is deliberate: the id IS the insertion order, and readers
 * page through these with `ORDER BY id` and an `id > ?` cursor. A
 * server-generated text id orders lexicographically, which is not insertion
 * order, and `recorded_at` is second-granular so ties within a run are ordinary.
 * Tenancy on those tables rides `project_id NOT NULL` under the grammar CHECK,
 * the composite foreign key to `agent_runs`, and every index leading with
 * `project_id` — the places it is actually read.
 *
 * `agents` and `agent_tasks` are the deliberate exception: they are Deployment
 * definitions — an agent's provider, model, prompt and tool access, and the task
 * catalogue — not Project data, so they carry no `project_id` and are named in
 * the index gate's Deployment-scoped allowlist.
 */
const V7_STATEMENTS: readonly string[] = [
  /** Agent identity, for attribution and model routing. Deployment-scoped: one agent configuration serves every Project the Deployment holds. */
  `CREATE TABLE IF NOT EXISTS agents (
     id                 TEXT PRIMARY KEY,
     name               TEXT NOT NULL,
     provider           TEXT,
     model              TEXT,
     system_prompt_hash TEXT,
     system_prompt      TEXT,
     config             TEXT,
     source             TEXT NOT NULL DEFAULT 'built-in',
     max_turns          INTEGER,
     timeout_seconds    INTEGER,
     tool_access        TEXT,
     enabled            INTEGER NOT NULL DEFAULT 1,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER)`,
  /** The task catalogue. Deployment-scoped for the same reason as `agents`: a task definition is not Project data. */
  `CREATE TABLE IF NOT EXISTS agent_tasks (
     id             TEXT PRIMARY KEY,
     agent_id       TEXT NOT NULL REFERENCES agents(id),
     source         TEXT NOT NULL DEFAULT 'built-in',
     display_name   TEXT,
     description    TEXT,
     prompt         TEXT NOT NULL,
     is_default     INTEGER NOT NULL DEFAULT 0,
     tool_overrides TEXT,
     model          TEXT,
     config         TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER)`,
  /**
   * The run audit trail.
   *
   * `resumable`, `resume_status`, `resume_mode`, `resumed_at`, `resume_attempts`
   * and `checkpoints` are the resumability machinery a dispatched run needs to
   * survive container replacement. `error` carries the explicit failure record:
   * a run that fails leaves a row saying so, so an empty result is always
   * distinguishable from a failed one.
   */
  `CREATE TABLE IF NOT EXISTS agent_runs (
     project_id         TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id                 TEXT NOT NULL,
     agent_id           TEXT NOT NULL REFERENCES agents(id),
     task               TEXT,
     instruction        TEXT,
     status             TEXT NOT NULL DEFAULT 'pending',
     harness            TEXT,
     provider           TEXT,
     model              TEXT,
     session_ref        TEXT,
     resumable          INTEGER NOT NULL DEFAULT 0,
     resume_status      TEXT,
     resume_mode        TEXT,
     resumed_at         INTEGER,
     resume_attempts    INTEGER NOT NULL DEFAULT 0,
     checkpoints        TEXT,
     usage_data         TEXT,
     started_at         INTEGER,
     completed_at       INTEGER,
     tokens_used        INTEGER,
     cost_usd           REAL,
     actual_cost_usd    REAL,
     estimated_cost_usd REAL,
     cost_source        TEXT,
     cost_data          TEXT,
     actions_taken      TEXT,
     error              TEXT,
     dry_run            INTEGER NOT NULL DEFAULT 0,
     reasoning_level    TEXT,
     execution_overrides TEXT,
     run_context        TEXT,
     dispatched_by      TEXT REFERENCES member_credentials(id),
     PRIMARY KEY (project_id, id))`,
  /** The single-flight claim reads this: a live run of one task, newest first. */
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs (project_id, task, status, started_at)`,
  /**
   * The dispatching credential, led by the credential rather than the Project.
   *
   * A credential spans every Project in its Deployment, and this index exists to
   * serve the foreign key check that runs whenever a credential row is written —
   * a lookup by credential alone. Leading it with `project_id` leaves that check
   * scanning `agent_runs`, which the cost gate observes.
   */
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_credential ON agent_runs (dispatched_by)`,
  `CREATE TABLE IF NOT EXISTS agent_run_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id      TEXT NOT NULL,
     phase_name  TEXT,
     event_type  TEXT NOT NULL,
     tool_name   TEXT,
     outcome     TEXT,
     duration_ms INTEGER,
     payload     TEXT,
     recorded_at INTEGER NOT NULL,
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events (project_id, run_id, recorded_at)`,
  /** What a dry run would have written, and how the classifier judged it. */
  `CREATE TABLE IF NOT EXISTS agent_run_write_intents (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id         TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id             TEXT NOT NULL,
     phase_id           TEXT,
     tool_name          TEXT NOT NULL,
     tool_input         TEXT NOT NULL,
     synthetic_output   TEXT NOT NULL,
     stub_id            TEXT,
     classifier_verdict TEXT,
     classifier_reason  TEXT,
     recorded_at        INTEGER NOT NULL,
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_write_intents_run ON agent_run_write_intents (project_id, run_id, recorded_at)`,
  `CREATE TABLE IF NOT EXISTS agent_turns (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id          TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id              TEXT NOT NULL,
     agent_id            TEXT NOT NULL REFERENCES agents(id),
     turn_number         INTEGER NOT NULL,
     tool_name           TEXT NOT NULL,
     tool_input          TEXT,
     tool_output_summary TEXT,
     started_at          INTEGER,
     completed_at        INTEGER,
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_agent_turns_run ON agent_turns (project_id, run_id, turn_number)`,
  `CREATE TABLE IF NOT EXISTS agent_reports (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id     TEXT NOT NULL,
     agent_id   TEXT NOT NULL REFERENCES agents(id),
     action     TEXT NOT NULL,
     summary    TEXT NOT NULL,
     details    TEXT,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_agent_reports_run ON agent_reports (project_id, run_id, created_at)`,
  /**
   * Per-Project agent state.
   *
   * The primary key leads with `project_id` so the conditional UPDATE behind an
   * atomic read-modify-write addresses exactly one row: a compare-and-swap that
   * could match rows in another Project is not a tenancy boundary.
   */
  `CREATE TABLE IF NOT EXISTS agent_state (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     agent_id   TEXT NOT NULL REFERENCES agents(id),
     key        TEXT NOT NULL,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, agent_id, key))`,
  /**
   * Spores — the durable observations recall reads.
   *
   * `prompt_batch_id` becomes `prompt_id`: a batch on a Deployment is identified
   * by `(project_id, prompt_id)`, and the local integer row id has no meaning
   * once batches arrive from many members.
   */
  `CREATE TABLE IF NOT EXISTS spores (
     project_id       TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id               TEXT NOT NULL,
     agent_id         TEXT NOT NULL REFERENCES agents(id),
     session_id       TEXT,
     prompt_id        TEXT,
     observation_type TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'active',
     content          TEXT NOT NULL,
     context          TEXT,
     importance       INTEGER NOT NULL DEFAULT 5,
     file_path        TEXT,
     tags             TEXT,
     content_hash     TEXT,
     properties       TEXT,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER,
     embedded         INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_spores_status ON spores (project_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_spores_type ON spores (project_id, observation_type, created_at)`,
  /** Rows the embedding reconciler still owes work for; partial so the scan is the backlog itself. */
  `CREATE INDEX IF NOT EXISTS idx_spores_unembedded ON spores (project_id, created_at) WHERE embedded = 0`,
  /** Supersede and consolidate lineage. Data is never deleted, so the event is the record of what replaced what. */
  `CREATE TABLE IF NOT EXISTS resolution_events (
     project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id           TEXT NOT NULL,
     agent_id     TEXT NOT NULL REFERENCES agents(id),
     spore_id     TEXT NOT NULL,
     action       TEXT NOT NULL,
     new_spore_id TEXT,
     reason       TEXT,
     session_id   TEXT,
     created_at   INTEGER NOT NULL,
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, spore_id) REFERENCES spores(project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_resolution_events_spore ON resolution_events (project_id, spore_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS skill_candidates (
     project_id            TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id                    TEXT NOT NULL,
     agent_id              TEXT NOT NULL REFERENCES agents(id),
     topic                 TEXT NOT NULL,
     rationale             TEXT NOT NULL,
     confidence            REAL NOT NULL DEFAULT 0.0,
     status                TEXT NOT NULL DEFAULT 'identified',
     source_ids            TEXT NOT NULL DEFAULT '[]',
     skill_id              TEXT,
     supersedes            TEXT,
     evidence_bundle_id    TEXT,
     quality_score         REAL,
     quality_failures      TEXT NOT NULL DEFAULT '[]',
     coverage_matches      TEXT NOT NULL DEFAULT '[]',
     last_reconciled_at    INTEGER,
     reconciliation_reason TEXT,
     created_at            INTEGER NOT NULL,
     updated_at            INTEGER NOT NULL,
     approved_at           INTEGER,
     PRIMARY KEY (project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates (project_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS skill_records (
     project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id           TEXT NOT NULL,
     agent_id     TEXT NOT NULL REFERENCES agents(id),
     name         TEXT NOT NULL,
     display_name TEXT NOT NULL,
     description  TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'active',
     embedded     INTEGER NOT NULL DEFAULT 0,
     generation   INTEGER NOT NULL DEFAULT 1,
     candidate_id TEXT,
     source_ids   TEXT NOT NULL DEFAULT '[]',
     path         TEXT NOT NULL,
     usage_count  INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL,
     properties   TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, candidate_id) REFERENCES skill_candidates(project_id, id))`,
  /** A skill name is one skill within a Project; two Projects may each hold their own. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_records_name ON skill_records (project_id, name)`,
  `CREATE TABLE IF NOT EXISTS skill_lineage (
     project_id       TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id               TEXT NOT NULL,
     skill_id         TEXT NOT NULL,
     generation       INTEGER NOT NULL,
     action           TEXT NOT NULL,
     rationale        TEXT NOT NULL,
     source_ids_added TEXT NOT NULL DEFAULT '[]',
     content_snapshot TEXT NOT NULL,
     created_at       INTEGER NOT NULL,
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, skill_id) REFERENCES skill_records(project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_skill_lineage_skill ON skill_lineage (project_id, skill_id, generation)`,
  `CREATE TABLE IF NOT EXISTS skill_usage (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id          TEXT NOT NULL,
     skill_id    TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     detected_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, skill_id) REFERENCES skill_records(project_id, id),
     FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage (project_id, skill_id, detected_at)`,
  /** The current digest per tier. Derived: regenerated under the 2.0 schema rather than migrated. */
  `CREATE TABLE IF NOT EXISTS digest_extracts (
     project_id     TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id             TEXT NOT NULL,
     agent_id       TEXT NOT NULL REFERENCES agents(id),
     tier           INTEGER NOT NULL,
     content        TEXT NOT NULL,
     substrate_hash TEXT,
     generated_at   INTEGER NOT NULL,
     PRIMARY KEY (project_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_digest_extracts_tier ON digest_extracts (project_id, tier, generated_at)`,
  /**
   * One current digest per agent and tier within a Project.
   *
   * The writer is a read-then-update-or-insert keyed on that triple, so the
   * uniqueness is what makes it address a single row. Without it two concurrent
   * digest runs each insert and both survive as current, and a reader receives
   * two answers to a question that has one. The 1.4 vault splits this across two
   * partial indexes to key a nullable `project_id`; NOT NULL collapses them.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_extracts_project_agent_tier ON digest_extracts (project_id, agent_id, tier)`,
  `CREATE TABLE IF NOT EXISTS digest_extract_revisions (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id         TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     agent_id           TEXT NOT NULL,
     tier               INTEGER NOT NULL,
     content            TEXT NOT NULL,
     metadata           TEXT,
     run_id             TEXT,
     parent_revision_id INTEGER REFERENCES digest_extract_revisions(id),
     created_at         INTEGER NOT NULL,
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE SET NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_digest_extract_revisions_tier ON digest_extract_revisions (project_id, tier, created_at)`,
  /**
   * Generated Cortex instructions.
   *
   * A nullable `project_id` needs two partial unique indexes to key this table,
   * one for rows with a project and one for rows without. With the column NOT
   * NULL the whole arrangement collapses into the primary key.
   */
  `CREATE TABLE IF NOT EXISTS cortex_instructions (
     project_id    TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id            TEXT NOT NULL,
     agent_id      TEXT NOT NULL,
     content       TEXT NOT NULL,
     input_hash    TEXT NOT NULL,
     source_run_id TEXT,
     generated_at  INTEGER NOT NULL,
     PRIMARY KEY (project_id, id))`,
  /**
   * Git provenance for a capture point.
   *
   * `identity_key` is globally UNIQUE locally, where one vault serves one Project.
   * On a Deployment it is unique WITHIN a Project: a global constraint would let
   * one Project's key refuse another Project's row.
   */
  `CREATE TABLE IF NOT EXISTS knowledge_git_provenance (
     id                       INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id               TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     identity_key             TEXT NOT NULL,
     session_id               TEXT,
     prompt_id                TEXT,
     capture_point            TEXT NOT NULL,
     captured_at              INTEGER NOT NULL,
     project_root             TEXT,
     branch                   TEXT,
     head_sha                 TEXT,
     upstream_ref             TEXT,
     upstream_sha             TEXT,
     production_ref           TEXT,
     production_sha           TEXT,
     is_dirty                 INTEGER NOT NULL DEFAULT 0,
     staged_count             INTEGER NOT NULL DEFAULT 0,
     unstaged_count           INTEGER NOT NULL DEFAULT 0,
     untracked_count          INTEGER NOT NULL DEFAULT 0,
     changed_paths_json       TEXT,
     tracked_blob_hashes_json TEXT,
     patch_ids_json           TEXT,
     status_hash              TEXT NOT NULL,
     evidence_json            TEXT,
     error                    TEXT,
     created_at               INTEGER NOT NULL,
     FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_git_provenance_identity ON knowledge_git_provenance (project_id, identity_key)`,
  /** Release state per namespaced record. `identity_key` is scoped to the Project for the same reason as git provenance. */
  `CREATE TABLE IF NOT EXISTS knowledge_release_state (
     project_id        TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     id                TEXT NOT NULL,
     identity_key      TEXT NOT NULL,
     namespace         TEXT NOT NULL,
     record_id         TEXT NOT NULL,
     source_session_id TEXT,
     source_prompt_id  TEXT,
     state             TEXT NOT NULL,
     confidence        TEXT NOT NULL,
     basis_kind        TEXT,
     basis_ref         TEXT,
     basis_sha         TEXT,
     release_pr_number INTEGER,
     reason            TEXT,
     evidence_json     TEXT,
     checked_at        INTEGER NOT NULL,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER,
     PRIMARY KEY (project_id, id),
     FOREIGN KEY (project_id, source_session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_release_state_identity ON knowledge_release_state (project_id, identity_key)`,
];


/**
 * v8: a member's GitHub identity, and the one-time authority that links it.
 *
 * `members.github_id` is the numeric account id as text, unique across members;
 * the OAuth session's `sub` is looked up here on every dashboard request.
 * `identity_link_authorities` is the enrollment-authority shape a third time:
 * minted by a member credential, hashed at rest, spent once by the signed-in
 * account that proves itself.
 */
const V8_STATEMENTS: readonly string[] = [
  `ALTER TABLE members ADD COLUMN github_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_members_github_id ON members (github_id)`,
  `CREATE TABLE IF NOT EXISTS identity_link_authorities (
     id          TEXT PRIMARY KEY,
     key_hash    TEXT NOT NULL,
     member_id   TEXT NOT NULL REFERENCES members(id),
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL,
     used_at     INTEGER,
     used_by     TEXT,
     revoked_at  INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_link_authorities_hash ON identity_link_authorities (key_hash)`,
];

/**
 * v9: access administration. Every revocation names who; External Agent grants;
 * the indexes a Deployment-wide credential list and activity read run on.
 */
const V9_STATEMENTS: readonly string[] = [
  `ALTER TABLE members ADD COLUMN revoked_by TEXT`,
  `ALTER TABLE enrollment_authorities ADD COLUMN revoked_by TEXT`,
  `ALTER TABLE identity_link_authorities ADD COLUMN revoked_by TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_member_credentials_started ON member_credentials (lineage_started_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_member_credentials_member ON member_credentials (member_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_token_only ON events (token_id, created_at, event_id)`,
  `CREATE TABLE IF NOT EXISTS external_grants (
     id           TEXT PRIMARY KEY,
     project_id   TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     key_hash     TEXT NOT NULL,
     label        TEXT,
     created_by   TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked_at   INTEGER,
     revoked_by   TEXT,
     rotated_to   TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_grants_hash ON external_grants (key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_external_grants_project ON external_grants (project_id, created_at, id)`,
];

/**
 * v10: project archival. An archived project refuses capture and leaves the
 * default listings; its history and attribution stay. `archived_by` names who.
 */
const V10_STATEMENTS: readonly string[] = [
  `ALTER TABLE projects ADD COLUMN archived_at INTEGER`,
  `ALTER TABLE projects ADD COLUMN archived_by TEXT`,
];

/**
 * v11: the built-in `user` agent. Spores a member records through the MCP
 * tools carry this agent, as they do in 1.4; seeding it here keeps the tool
 * path a reader of `agents`, never a writer.
 */
const V11_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('user', 'User (MCP)', 'built-in', 1, 0)`,
];

/**
 * v12: a session's title and summary, written on the Deployment once the session
 * has ended. `titled_at` records the attempt, made at most once per session.
 */
const V12_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN title TEXT`,
  `ALTER TABLE sessions ADD COLUMN summary TEXT`,
  `ALTER TABLE sessions ADD COLUMN titled_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_titled ON sessions (project_id, titled_at)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_first ON prompt_batches (project_id, session_id, created_at, prompt_id)`,
];

/**
 * v13: the backup index and the Deployment's lineage id. A backup artifact in
 * the object store is described by one row here; the lineage id names THIS
 * Deployment in every artifact header, so a restore can refuse a foreign dump
 * unless the operator deliberately adopts it.
 */
const V13_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS backups (
     id             TEXT PRIMARY KEY,
     key            TEXT NOT NULL,
     created_at     INTEGER NOT NULL,
     size_bytes     INTEGER NOT NULL,
     counts_json    TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     producer       TEXT NOT NULL,
     pinned         INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_backups_created ON backups (created_at, id)`,
  `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('deployment_id', lower(hex(randomblob(16))))`,
];

/**
 * v14: the session page reads a session as turns — each prompt with the tool
 * calls, responses, attachments and steering children that name it — and the
 * session rail reads per-session activity. These indexes serve those reads:
 * the child tables by `(session, prompt)`, prompt batches by origin within a
 * session, and a prompt's steering children by their parent.
 */
const V14_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_prompt ON tool_calls (project_id, session_id, prompt_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_prompt ON attachments (project_id, session_id, prompt_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_turns ON prompt_batches (project_id, session_id, origin, created_at, prompt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (project_id, session_id, parent_prompt_id)`,
];

/**
 * v15: a plan names the prompt it came from and the member behind its last
 * administrative edit; a session names the member who asked for its title.
 * `prompt_id` serves the turn body; `updated_by` and `titled_by` are NULL when
 * the last write came from a capture event or the automatic titling attempt.
 */
const V15_STATEMENTS: readonly string[] = [
  `ALTER TABLE plans ADD COLUMN prompt_id TEXT`,
  `ALTER TABLE plans ADD COLUMN updated_by TEXT`,
  `ALTER TABLE sessions ADD COLUMN titled_by TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_plans_prompt ON plans (project_id, session_id, prompt_id, updated_at)`,
];

function withStamp(version: number, statements: readonly string[]): SchemaStep {
  return { version, statements: [...statements, `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '${version}')`] };
}

/** Ordered schema steps; each step's last statement stamps its version. A database at version n receives steps n+1 and later. Step 2 opens with two guard tables, ahead of every ADD COLUMN so a repaired database re-applies the step whole: one CHECK fails when an existing project id is out of grammar, the other when a session has no machine identity and the token that minted it has none to backfill from. The step aborts on the guard's insert and the applier records nothing. Identity binding reads `machine_id`, so a session that kept a NULL refuses every later write to itself; BREAK-GLASS.md carries the repair. */
export const SCHEMA_STEPS: readonly SchemaStep[] = [withStamp(1, V1_STATEMENTS), withStamp(2, V2_STATEMENTS), withStamp(3, V3_STATEMENTS), withStamp(4, V4_STATEMENTS), withStamp(5, V5_STATEMENTS), withStamp(6, V6_STATEMENTS), withStamp(7, V7_STATEMENTS), withStamp(8, V8_STATEMENTS), withStamp(9, V9_STATEMENTS), withStamp(10, V10_STATEMENTS), withStamp(11, V11_STATEMENTS), withStamp(12, V12_STATEMENTS), withStamp(13, V13_STATEMENTS), withStamp(14, V14_STATEMENTS), withStamp(15, V15_STATEMENTS)];

/** Every statement of every step, in application order. */
export const SCHEMA_DDL: readonly string[] = SCHEMA_STEPS.flatMap((s) => s.statements);
