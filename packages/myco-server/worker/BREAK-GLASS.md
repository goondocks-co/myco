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

Rows written by a revoked token are never deleted by this procedure.
