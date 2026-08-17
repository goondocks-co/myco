# myco-server Worker

Schema is applied at deploy time, never on the request path. Every member request reads the database schema version in the same query as the token lookup — before any token decision — and answers 503 when the version row is missing or is not the version this build was written against, so a deploy that skipped the schema step, or applied a stale one, fails closed rather than dropping events. `GET /health` reads no storage. A Worker bound to a validly migrated but wrong database answers 401 to every member (the schema matches, no tokens match); that binding error becomes visible in the owner status surface, not in ingest responses.

First remote deploy:

```bash
npx wrangler d1 create myco-server                       # once; copy wrangler.toml to a gitignored wrangler.deploy.toml carrying the printed database_id
npm run schema:emit                                      # regenerate schema.sql from src/db/schema.ts
npx wrangler d1 execute myco-server --remote -c wrangler.deploy.toml --file ./schema.sql
npx wrangler deploy -c wrangler.deploy.toml
npm run token:mint -- <project_id> [machine_id]          # prints the projects row and the member_tokens insert; apply both with wrangler d1 execute --remote
```

Local development: `npm run schema:apply` (local D1) then `npm run dev`. `smoke.md` is the local smoke procedure and its last observed output.

Responses on `POST /events`: `200 {persisted:true}` stored; `200 {persisted:true, duplicate:true}` a replay of an identical envelope; `200 {persisted:false, reason}` a terminal refusal of that request — never retry it (malformed or unknown-field envelope, size, depth or node cap, an event id already stored with a different envelope, write quota); `503 {persisted:false, reason:'unavailable'}` with `retry-after` a server-side failure — retry it. `401`/`429` before authentication; `401` to an authenticated member on a route this build does not serve.

Envelope: `{eventId, sessionId, kind, createdAt, channel, payload}` and nothing else — a field the server does not store is refused by name, never dropped. Identifiers are at most 192 characters (a 128-character machine id, a separator, and a UUID). Event ids are chosen by the member and must be unguessable (`<machine_id>:<uuid>`); an id already stored in the project is a duplicate when the whole envelope matches and a conflict otherwise. `sessions` rows are a projection of stored events: `first_received_at`/`last_received_at` are server clock times, and `created_by_token_id`/`machine_id` name the first inserter; a request that stores nothing writes nothing.

Write quota: `member_tokens.bytes_written` counts the request body bytes of events the server stored for that token, enforced by the `member_tokens_quota` CHECK inside the same transaction as the insert; refused, duplicate, conflicting, and oversized requests are not charged, and their ingress is bounded only by the token rate limit and the body cap. Changing `MEMBER_TOKEN_BYTE_QUOTA` changes the CHECK expression, so on a live database it is a schema migration, not a redeploy.

Rate limits: `SOURCE_LIMIT` is charged only when a request ends without a member identity and never refuses an authenticated member; `TOKEN_LIMIT` bounds each token. The Cloudflare rate-limit binding counts per edge server and is eventually consistent — a single-connection client is limited near the configured value, a client that fans out connections is not — so the byte quota, not the rate limit, is the bound on what a stolen token can store. A well-formed unknown token costs one indexed lookup before it is refused.

Tokens are compared by SHA-256 digest through a unique index; the digest is never a caller-steerable value. Telemetry carries classifiers, server-issued identifiers, and a digest prefix of the source identity — never a request body, path, or address.

Member tokens: `npm run token:mint -- <project_id> [machine_id] [--print-token]` prints the `INSERT OR IGNORE` for `projects` and the `INSERT` for `member_tokens` on stdout; the raw token is printed to stderr only with `--print-token`. `npm run token:revoke -- <token_id>` prints the matching `UPDATE`. Both render the statements `issueMemberToken` / `revokeMemberToken` execute; see `BREAK-GLASS.md` for the emergency procedure.
