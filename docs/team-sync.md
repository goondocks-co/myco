# Team Sync

Share captured knowledge across machines and team members through a Cloudflare-backed sync layer. Every teammate's agents benefit from the collective intelligence — the same digest, the same spores, the same graph — without you having to think about it.

Team sync also deploys a [Cloud MCP Server](cloud-mcp.md) that exposes your project's knowledge to cloud agents (Anthropic Managed Agents, N8N, etc.). See [Cloud MCP docs](cloud-mcp.md) for that side of the feature.

## What you get

- Every new spore, session, plan, and graph edge syncs automatically in the background
- Search queries fan out to both local and team data — results merge by relevance, tagged with source
- Team context is additive — if the Worker is slow or unreachable, local results return alone
- One-time backfill pushes all existing knowledge to the team store on first connect
- Runs on the Cloudflare free tier for small teams

Local databases remain the source of truth — the cloud store is a queryable mirror. Nothing is pulled back down. Each record carries a machine identity for attribution.

## Quick start

### 1. Install Wrangler

Install Wrangler and the team operator CLI. Only the person provisioning the team needs `@goondocks/myco-team` — teammates who are just connecting don't.

```bash
npm install -g wrangler @goondocks/myco-team
wrangler login
```

### 2. Create the team

One team member runs this once. It provisions the Cloudflare infrastructure and deploys the sync Worker.

```bash
myco-team install
```

The command outputs a **Worker URL** and **API key**. Share these with teammates through your preferred out-of-band channel.

The full `myco-team` CLI surface: `install`, `upgrade`, `status`, `rotate-tokens`, `reindex-vectors`, `destroy`.

### 3. Connect teammates

Each teammate opens the **Team** page in their Myco dashboard (`http://localhost:<port>/team`), pastes the Worker URL and API key, and clicks **Connect**. Their node registers with the Worker and begins syncing immediately.

On first connect, all existing local knowledge is backfilled into the outbox and pushed to the team store in batches. New writes sync automatically going forward.

The daemon hands records off to the Worker via `POST /enqueue`. The Worker fans them into a project-scoped Cloudflare Queue (`myco-team-<hash>-sync`); a queue consumer in the same Worker writes to D1 + Vectorize. Cloudflare's queue runtime owns retries, exponential backoff, and dead-lettering — once a payload is accepted by `/enqueue`, the daemon's job is done. Failures past `max_retries` (default 10) land in a project-scoped DLQ (`myco-team-<hash>-sync-dlq`) where operators can replay or discard them from the Team page.

## What syncs

| Synced | Not synced |
|--------|------------|
| Spores (observations, wisdom) | Activities (tool call detail) |
| Sessions (metadata, title, summary) | Agent execution traces |
| Prompt batches (prompts, AI summaries) | Log entries |
| Entities and graph edges | Attachments (images) |
| Plans and artifacts | Buffer files |
| Resolution events | |
| Digest extracts | |
| Skill records and candidates | |

Teammates see what was asked and answered, not every file read or bash command. That keeps the team store useful and keeps sync cost bounded.

## Machine identity

Every synced record is tagged with a **machine identity** — a deterministic `{github_username}_{machine_hash}` (e.g. `chris_a7b3c2`). This lets search results attribute knowledge to its source, and lets you filter "my data" vs "team data" when you want to.

The identity is generated once per machine and cached at `.myco/machine_id`. Nothing to configure.

## Search fan-out

When team sync is connected, search queries hit both local and cloud databases in parallel, then merge by relevance score. Each result is tagged so you can tell where it came from:

- `source: "local"` — from this machine
- `source: "team:chris_a7b3c2"` — from the team store, attributed

If the cloud Worker is unreachable within a short timeout, local results return alone. Team search is always additive, never blocking.

## Cloud embedding alternative

If you don't want to run Ollama locally for embeddings, point at Cloudflare Workers AI instead — it uses the same model as the Worker, so embeddings are directly comparable:

```yaml
# myco.yaml
embedding:
  provider: openai-compatible
  model: "@cf/baai/bge-m3"
  base_url: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1
```

Store your Cloudflare API token in `secrets.env`.

## Backup & restore

Independent of team sync, Myco creates local SQL dump backups for resilience. Configure the backup directory on the **Operations** page, or click **Backup Now** for an on-demand dump. Restore supports a dry-run preview, and cross-machine restore preserves attribution so you can pull a teammate's backup file without losing who said what.

Backups include all knowledge tables but exclude logs, tool call activities, and vector embeddings (rebuilt automatically after restore).

## Worker management

### Upgrade

Any team member with Wrangler and `@goondocks/myco-team` installed can update the Worker to match their installed Myco version:

```bash
myco-team upgrade
```

Or click **Update Worker** on the Team page when an update is available (this runs the upgrade through the daemon, no local `myco-team` install required). The upgrade handles new infrastructure (like the KV namespace added for Cloud MCP), installs new runtime dependencies, and redeploys.

The Operations page detects and applies package updates to `@goondocks/myco-team` when that CLI is installed on the same machine. Manual npm updates still work:

```bash
npm update -g @goondocks/myco-team
myco-team upgrade
```

### Architecture

The Worker is stateless — no WebSocket connections, no in-memory state. Each request reads from D1 or Vectorize, processes, and returns. Cloudflare handles scaling.

Two Worker route groups:

- **Sync routes** (`/connect`, `/enqueue`, `/search`, `/config`, `/health`) — authenticated with the team API key, used by your daemon. `/enqueue` replaces the legacy `/sync` route; the new path hands records to a managed Cloudflare Queue rather than writing to D1 directly.
- **Operator routes** (`/queue-stats`, `/dlq`, `/dlq/retry`, `/dlq/discard`, `/tokens/cf-api`) — also team-API-key-authenticated; back the Outbox tab on the Team page. Require a Cloudflare API token with `queues:read,write` scope, set via the Outbox tab's first-run prompt and stored in the Worker's KV namespace.
- **MCP routes** (`/mcp/*`, `/mcp/rotate`) — the [Cloud MCP Server](cloud-mcp.md) that cloud agents connect to

### Cost

A small team (2-5 developers) stays comfortably within the Cloudflare free tier. The $5/month paid tier provides significant headroom if your team outgrows free.

## Dashboard

### Team page

- **Not connected** — setup instructions and connect form (Worker URL + API key)
- **Connected** — three tabs:
  - **Status** — connection health, team credentials (with show/hide for the API key), machine identity, MCP endpoint + token + rotate, remote vector index status
  - **Outbox** — local hand-off counters + Cloudflare queue depth + dead-letter list with per-message **Replay** and **Discard** actions, plus **Replay all**. First-run requires a Cloudflare API token with `queues:read,write` scope (paste into the inline form; stored in the Worker's KV namespace, never sent back to the daemon)
  - **Synced data** — version + machine identity overview and an explicit "What stays local" disclosure (`cortex_instructions` plus the Canopy injection telemetry columns on `sessions`)
- **Cloud MCP Endpoint** — on the Status tab. Shows the MCP URL, a redacted bearer token, a pre-formatted config snippet for Anthropic Managed Agents, and a "Rotate token" action. See [Cloud MCP docs](cloud-mcp.md).

### Operations page

- Backup directory configuration
- Backup Now button
- Backup history with restore preview
