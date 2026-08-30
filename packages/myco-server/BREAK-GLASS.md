# Break-glass: minting an enrollment authority

The recovery path of last resort. Whoever controls the Deployment's infrastructure can mint an invitation directly in the store, then join normally — so losing every credential is recoverable while you still hold database access.

`scripts/mint-enrollment.ts` connects to nothing and holds no credential: it renders the SQL for you to apply. The raw key goes to stderr and only with `--print-key`, so the rendered statement can be piped to a client without the secret travelling with it.

```bash
cd packages/myco-server
# Render the insert. Prints the digest, never the key.
bun scripts/mint-enrollment.ts 30

# Print the key to stderr as well, once. Nothing stores it; if you lose it, mint another.
bun scripts/mint-enrollment.ts 30 --print-key
```

Apply it on the hosted target:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command "$(bun scripts/mint-enrollment.ts 30 --print-key)"
# The key lands on your terminal from stderr; the command substitution carries only the SQL.
```

Self-hosted, apply the same statement against the SQLite file on the mounted volume.

Then join with the key. It is single-use, expires on the TTL you passed, and records which runtime spent it:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, created_at, expires_at, used_at, used_by_runtime, revoked_at FROM enrollment_authorities ORDER BY created_at DESC LIMIT 5"
```

Revoke an unused key you no longer want outstanding:

```sql
UPDATE enrollment_authorities SET revoked_at = <now_ms>, revoked_by = '<your member id>' WHERE id = '<ID>' AND revoked_at IS NULL AND used_at IS NULL;
```

**Every use of this path should be a cause for investigation.** It bypasses the join flow's ordinary attribution: the resulting authority names no minting member. Mint one, use it, and let it expire — do not keep a standing key.

# Break-glass: linking a GitHub account directly

The steady-state path is `myco member link-github` on a machine that has joined: it mints a one-time link, the member opens it, signs in through GitHub, and confirms — the account is proven, never typed. This path proves nothing. Use it when no linked member can sign in — the first member of a fresh Deployment before the CLI path exists on their machine, or a member whose account must change (an account is fixed once linked; this is the only way to replace it).

`scripts/link-github.ts` renders the UPDATE for you to apply. Find the member id first (`SELECT id, label, github_id FROM members WHERE revoked_at IS NULL`), and the numeric GitHub account id from `https://api.github.com/users/<login>` — never the login, which can be renamed and reclaimed.

```bash
cd packages/myco-server
bun scripts/link-github.ts mem_xxxxxxxx 583231
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command "$(bun scripts/link-github.ts mem_xxxxxxxx 583231)"
```

Self-hosted, apply the same statement against the SQLite file on the mounted volume.

**Every use of this path should be a cause for investigation**: it binds an account nobody proved control of, on the operator's word.

# Break-glass: revoking a member token

Ordinary offboarding is the dashboard (`POST /api/members/{memberId}/revoke`): one transaction ending the member and everything live that is theirs, attributed. This path is for a token whose member must stay.


A leaked member token is revoked by setting `revoked_at` on its row. The pipeline refuses a revoked token on the next request; there is no cache to flush.

`revokeCredentialAsMember` is the code path; `npm run token:revoke -- <TOKEN_ID> <YOUR_MEMBER_ID>` prints its attributed `UPDATE`. Find the credential by member and machine, print the statement, apply it with `wrangler d1 execute`, then confirm the command reported one changed row — zero rows means no live credential had that id:

```bash
cd packages/myco-server
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, member_id, machine_id, expires_at, revoked_at, bytes_written FROM member_credentials WHERE member_id = '<MEMBER_ID>'"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command "$(npm run -s token:revoke -- <TOKEN_ID> <YOUR_MEMBER_ID>)"
```

Attribution: every `events` row carries the `token_id` that wrote it, so what a revoked credential wrote is a query, not a guess. A credential spans the Deployment, so the query below is per Project and answers for that Project only — drop `project_id` from the predicate to see the whole footprint, at the cost of the `idx_events_token (project_id, token_id, created_at)` index it is ordered by. `sessions.created_by_token_id` names the token that first opened the session and is not updated by later writers; query `events`, not `sessions`, for a token's footprint:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT session_id, COUNT(*) AS events, MIN(received_at), MAX(received_at) FROM events WHERE project_id = '<PROJECT_ID>' AND token_id = '<TOKEN_ID>' GROUP BY session_id"
```

Blobs carry the same attribution: `blobs.token_id` names the first uploader of each key in the project (a later duplicate upload by another token is answered from the row and never re-attributed), and `events.blob_key` names the blob an event referenced:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT key, size, media_type, received_at FROM blobs WHERE project_id = '<PROJECT_ID>' AND token_id = '<TOKEN_ID>'"
```

Rows and objects written by a revoked token are never deleted by this procedure.

# Break-glass: revoking a token lineage

A member token refreshes itself inside the last quarter of its TTL (`POST /tokens/refresh`), so a leaked token may already have a successor — and its successor another — each a live credential with its own digest. Every token of a chain carries `lineage_root`, the id of the operator-minted token the chain began with; `revokeMemberLineage` sets `revoked_at` on every live row of that lineage in one statement, and `npm run token:revoke -- <TOKEN_ID> <YOUR_MEMBER_ID> --lineage` prints it, attributed, for any id in the chain. Read the chain first, then revoke it whole, then confirm the count of changed rows matches the live rows you read:

```bash
cd packages/myco-server
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, predecessor_id, lineage_root, expires_at, first_used_at, revoked_at, bytes_written FROM member_credentials WHERE lineage_root = (SELECT lineage_root FROM member_credentials WHERE id = '<TOKEN_ID>') ORDER BY expires_at"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command "$(npm run -s token:revoke -- <TOKEN_ID> <YOUR_MEMBER_ID> --lineage)"
```

`first_used_at` on a successor is the instant it first authenticated — the instant its predecessor was revoked — and `predecessor_id` names which token refreshed it; a successor the owner never used, on a lineage the owner never refreshed, is the thief's. Revoking one token (`token:revoke` without `--lineage`) is right only when its successors are known to be the owner's; it leaves them live. After a lineage revoke the member is re-provisioned: mint a new root with `token:mint`. Attribution is unchanged — every `events` row names the `token_id` that wrote it, so the footprint of each token in the chain is the query above.

# Break-glass: a migration that failed part-way

Two records say what the database is: the ledger `d1_migrations` (which files wrangler considers applied) and `schema_meta.version` (the version the request path demands, [src/db/schema.ts](src/db/schema.ts)). A request whose token row reports a different version than `SCHEMA_VERSION` is answered 503, so a half-applied migration takes the server offline rather than serving a torn schema.

Observed on wrangler 4.123 with `--local`: a file whose *last* statement fails is applied as a unit — the ledger gained no row for it, `schema_meta.version` stayed at the previous version, and none of that file's earlier `CREATE TABLE`/`ALTER TABLE` statements survived. `wrangler d1 migrations apply` exited non-zero with the SQLite error. The recovery below assumes nothing about that atomicity, because it has only been observed locally.

Read both records before touching anything:

```bash
cd packages/myco-server
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT key, value FROM schema_meta"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"
```

The three answers place the database in one of two states:

- **Ledger and version agree, and the tables the version claims are present** — the migration did not land. Fix the SQL and re-run `npm run migrations:apply`.
- **They disagree** (a ledger row for a file whose objects are missing, or a `schema_meta.version` ahead of the tables) — the file landed part-way. Drop the objects that file created, delete its ledger row, then re-apply:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "DROP TABLE IF EXISTS <TABLE_THE_FILE_CREATED>"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE schema_meta SET value = '<PREVIOUS_VERSION>' WHERE key = 'version'"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "DELETE FROM d1_migrations WHERE name = '<FILE>.sql'"
npm run migrations:apply
```

`ALTER TABLE ... ADD COLUMN` has no inverse in SQLite; a re-run over a column that already exists fails with `duplicate column name`. Migrations are emitted from `V*_STATEMENTS` ([src/db/schema.ts](src/db/schema.ts)) and every statement there is written `IF NOT EXISTS` where the syntax allows it, so re-application is safe for everything except `ADD COLUMN` — for those, delete the `ALTER` from the emitted file for the recovery run only, and never edit a file the ledger already records.

**Do NOT drop the objects for step 5.** The rule above is for a file whose `ADD COLUMN` cannot be re-run. Step 5 has none: every statement is `IF NOT EXISTS`, `OR IGNORE` or `OR REPLACE`, and the step opens by dropping its own guard table, so re-application over an already-migrated database is a no-op. The tables it creates — `members`, `member_credentials`, `machine_claims`, `enrollment_authorities` — hold the LIVE credentials of a serving Deployment the moment it is past the backfill. Dropping them destroys every member's ability to capture and every record of who wrote what. For step 5 the recovery is `npm run migrations:apply`, and nothing else.

# Break-glass: step 2 refused by a guard

Step 2 opens with two guard tables, ahead of every `ADD COLUMN`, so an aborted run leaves the database at v1 and a repaired one re-applies the step whole. Both fail the same way — `CHECK constraint failed: ok` on the guard's `INSERT` — so read which rows tripped it before repairing.

**A project id out of grammar.** v2 restricts a project id to `A-Za-z0-9._-`, 1–64 characters, and neither `.` nor `..`:

```bash
cd packages/myco-server
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT project_id FROM projects WHERE NOT (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..'))"
```

Rename each row to a value in grammar. Every table that names the project carries the id as data, so rename them together in one statement per table, then re-run `npm run migrations:apply`.

**A session with no machine identity.** Identity binding reads `sessions.machine_id`: a session that keeps a NULL refuses every later write to itself, and no member request can repair it. Step 2 backfills the column from the token that opened the session, so the guard trips only where that token carries no machine id either:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT s.project_id, s.session_id, s.created_by_token_id, s.first_received_at FROM sessions s WHERE s.machine_id IS NULL AND (SELECT machine_id FROM member_tokens WHERE id = s.created_by_token_id) IS NULL"
```

Each row is a session whose writer is unknown to the database. Decide per row, then re-run `npm run migrations:apply`:

- **The machine is known from outside the database** (the operator recognises the token, or `events.producer_adapter`/`origin_path` on the session identifies the host) — set it, and the session's later events continue to land:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE sessions SET machine_id = '<MACHINE_ID>' WHERE project_id = '<PROJECT_ID>' AND session_id = '<SESSION_ID>'"
```

- **The machine is not recoverable** — bind the session to a name no member holds. Its rows are preserved and readable; no member can write to it again, which is what an unattributable session already means:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE sessions SET machine_id = 'unattributed:' || session_id WHERE project_id = '<PROJECT_ID>' AND machine_id IS NULL AND (SELECT machine_id FROM member_tokens WHERE id = created_by_token_id) IS NULL"
```

Deleting the sessions is not one of the choices: their events are the record the projections re-derive from.

**A credential the backfill cannot place.** The guard covers three columns:
`machine_id`, `lineage_root` and `lineage_started_at`. The latter two are nullable
at the source — v3 added them with `ADD COLUMN`, which cannot carry NOT NULL — and
NOT NULL at the target, so a NULL in either is a row the insert would decline. A
closing guard then aborts if the backfill placed fewer credentials than the source
holds, whatever declined them.

v5 groups credentials into members by
`machine_id` — `mem_<machine_id>` is the member each backfilled credential joins.
A NULL has nothing to derive from, and grouping every such row under one member
would permanently merge distinct people, which is not reconcilable afterwards.
The guard trips before any of v5's writes, so the step lands nothing:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, project_id, machine_id, lineage_root, lineage_started_at, expires_at, revoked_at FROM member_tokens WHERE machine_id IS NULL OR lineage_root IS NULL OR lineage_started_at IS NULL"
```

A row with no machine identity is one the pipeline already refuses each write
(`no_machine_identity`), so none of those is a working credential. A row missing
only its lineage columns may well be live — v3's backfill filled them for every
row that existed then, so a NULL means the row was written by something that
bypassed `issueMemberToken`. Decide per row, then re-run `npm run migrations:apply`:

- **Lineage columns are NULL** — a credential is the root of its own lineage
  unless it succeeded another, so set them from the row itself. Do this before
  the machine-identity repair below, which may revoke the row:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE member_tokens SET lineage_root = COALESCE(lineage_root, id), lineage_started_at = COALESCE(lineage_started_at, expires_at - 604800000) WHERE lineage_root IS NULL OR lineage_started_at IS NULL"
```

- **The machine is known from outside the database** — set it, and the credential
  joins that machine's member:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE member_tokens SET machine_id = '<MACHINE_ID>' WHERE id = '<TOKEN_ID>'"
```

- **The machine is not recoverable** — revoke the row. v5 writes every backfilled
  credential revoked in any case, so revoking first changes nothing about what
  the migration produces; it only lets the guard pass. The name carries a `:`,
  which the machine-id grammar excludes, so the member the backfill derives from
  it can never collide with a real machine's. Attribution is untouched:
  `events.token_id` still names this id, and the read path resolves it:

```bash
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "UPDATE member_tokens SET machine_id = 'unattributed:' || id, revoked_at = COALESCE(revoked_at, expires_at) WHERE machine_id IS NULL"
```

Deleting the rows is not one of the choices: `events.token_id` references them,
and the owner API's activity read resolves a token id through this table.

# A note on the retired step-up key

Earlier builds guarded provider settings and credentials with a separate operator-minted key. That mechanism left the product on 2026-08-30 (#1036): a signed-in member changes provider settings and stores credentials directly, and the `step_up_authorities` table sits dormant in existing databases. Nothing here needs minting anymore.
