# Break-glass: revoking a member token

A leaked member token is revoked by setting `revoked_at` on its row. The pipeline refuses a revoked token on the next request; there is no cache to flush.

`revokeMemberToken` is the code path; `npm run token:revoke -- <TOKEN_ID>` prints its `UPDATE`. Find the token by project and machine, print the statement, apply it with `wrangler d1 execute`, then confirm the command reported one changed row — zero rows means no live token had that id:

```bash
cd packages/myco-server/worker
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command \
  "SELECT id, project_id, machine_id, expires_at, revoked_at, bytes_written FROM member_tokens WHERE project_id = '<PROJECT_ID>'"
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --command "$(npm run -s token:revoke -- <TOKEN_ID>)"
```

Attribution: every `events` row carries the `token_id` that wrote it, so what a revoked token wrote is a query, not a guess. `sessions.created_by_token_id` names the token that first opened the session and is not updated by later writers; query `events`, not `sessions`, for a token's footprint:

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

# Break-glass: a migration that failed part-way

Two records say what the database is: the ledger `d1_migrations` (which files wrangler considers applied) and `schema_meta.version` (the version the request path demands, [src/db/schema.ts](src/db/schema.ts)). A request whose token row reports a different version than `SCHEMA_VERSION` is answered 503, so a half-applied migration takes the server offline rather than serving a torn schema.

Observed on wrangler 4.123 with `--local`: a file whose *last* statement fails is applied as a unit — the ledger gained no row for it, `schema_meta.version` stayed at the previous version, and none of that file's earlier `CREATE TABLE`/`ALTER TABLE` statements survived. `wrangler d1 migrations apply` exited non-zero with the SQLite error. The recovery below assumes nothing about that atomicity, because it has only been observed locally.

Read both records before touching anything:

```bash
cd packages/myco-server/worker
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

# Break-glass: step 2 refused by a guard

Step 2 opens with two guard tables, ahead of every `ADD COLUMN`, so an aborted run leaves the database at v1 and a repaired one re-applies the step whole. Both fail the same way — `CHECK constraint failed: ok` on the guard's `INSERT` — so read which rows tripped it before repairing.

**A project id out of grammar.** v2 restricts a project id to `A-Za-z0-9._-`, 1–64 characters, and neither `.` nor `..`:

```bash
cd packages/myco-server/worker
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
