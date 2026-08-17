# myco-server Worker

Schema is applied at deploy time, never on the request path. Every member request reads the database schema version alongside the token row and answers 503 when it is not the version this build was written against, so a deploy that skipped the schema step — or applied a stale one — fails closed rather than dropping events.

First remote deploy:

```bash
npx wrangler d1 create myco-server      # once; paste the printed database_id into wrangler.toml
npm run schema:emit                     # regenerate schema.sql from src/db/schema.ts
npm run schema:apply:remote             # apply to the remote D1 — before the first deploy and after any schema change
npm run deploy
```

Local development: `npm run schema:apply` (local D1) then `npm run dev`.

Responses on `POST /events`: `200 {persisted:true}` stored; `200 {persisted:true, duplicate:true}` an identical replay; `200 {persisted:false, reason}` a terminal refusal of that request (malformed envelope, size or depth cap, event id conflict, write quota) — never retry it; `503 {persisted:false, reason:'unavailable'}` with `retry-after` a server-side failure — retry it. `401`/`429` before authentication.

Write quota: `member_tokens.bytes_written` counts the body bytes of events the server stored for that token, enforced by the `member_tokens_quota` CHECK inside the same transaction as the insert; refused, duplicate, and oversized requests are not charged. Changing `MEMBER_TOKEN_BYTE_QUOTA` changes the CHECK expression, so on a live database it is a schema migration, not a redeploy.

Member tokens: `npm run token:mint -- <project_id> [machine_id] [--print-token]` prints the `INSERT` for `member_tokens` on stdout; the raw token is printed to stderr only with `--print-token`. `npm run token:revoke -- <token_id>` prints the matching `UPDATE`. Both render the statements `issueMemberToken` / `revokeMemberToken` execute; see `BREAK-GLASS.md` for the emergency procedure.
