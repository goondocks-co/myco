/**
 * The committed Cloudflare Worker configuration, embedded so `myco server
 * config` renders a deploy config from a deployed install with no repo
 * checkout. `tests/server/wrangler-template-drift.test.ts` holds this constant
 * byte-identical to `packages/myco-server/wrangler.toml` — the file wrangler
 * reads in development and CI, and the base every deploy config derives from.
 * On drift, copy the file's bytes back into this constant.
 */
export const WRANGLER_TEMPLATE = `name = "myco-server"
main = "src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = [ "global_fetch_strictly_public" ]

[observability]
enabled = true

[observability.logs]
invocation_logs = false

[[d1_databases]]
binding = "MYCO_DB"
database_name = "myco-server"
database_id = "<YOUR_D1_DATABASE_ID>"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "myco-server-blobs"

[[ratelimits]]
name = "SOURCE_LIMIT"
namespace_id = "1001"
simple = { limit = 600, period = 60 }

[[ratelimits]]
name = "TOKEN_LIMIT"
namespace_id = "1002"
simple = { limit = 300, period = 60 }

# The key Deployment-held secrets are sealed under. Declared here so a deploy that
# omits it is visible in configuration rather than at the first attempt to store a
# credential. NOT in REQUIRED_BINDINGS: a Deployment that never stores one serves
# every other route without it, and the failure belongs at the first seal.
#
# Create the store and the secret once, then bind. An account holds ONE
# secrets store: reuse the existing store id (npx wrangler secrets-store
# store list --remote) rather than creating a second.
#   npx wrangler secrets-store store create myco --remote   # only when the account has none
#   head -c 32 /dev/urandom | base64 | npx wrangler secrets-store secret create <STORE-ID> \\
#     --name myco-secret-wrap-key --scopes workers --remote
#
# Rotating this value makes every stored credential unreadable until it is
# re-entered; a slot in that state reports \`readable: false\` rather than failing
# the whole surface. See #964.
# [[secrets_store_secrets]]
# binding = "SECRET_WRAP_KEY"
# store_id = "<STORE-ID>"
# secret_name = "myco-secret-wrap-key"

# The dashboard: static build output served from the edge store before the
# Worker runs. \`run_worker_first\` names every path the Worker owns — its live
# routes and the retired 1.4 prefixes it answers 401 — and is held equal to
# \`ownedPathPatterns()\` in src/routes.ts by tests/myco-server/gates.test.ts.
# No binding: the Worker never fetches an asset itself.
[assets]
directory = "ui/dist"
not_found_handling = "single-page-application"
run_worker_first = [ "/api/*", "/auth/*", "/blobs/*", "/context/*", "/events", "/events/*", "/health", "/mcp", "/members/*", "/routed-capture/*", "/runs/*", "/sessions/*", "/spores/*", "/tokens/*" ]
`;
