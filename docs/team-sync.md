# Team Sync

Share captured knowledge across machines and team members through a Cloudflare-backed sync layer. Each teammate keeps their local Grove database, and Team Sync mirrors connected teammates' Grove data into a queryable team store. Every teammate's agents benefit from the collective intelligence — the same digest, the same spores, the same graph — without you having to think about it.

Team Sync also deploys a secure [Cloud MCP Server](cloud-mcp.md) that exposes synced Grove knowledge to cloud agents (Anthropic Managed Agents, N8N, etc.). See [Cloud MCP docs](cloud-mcp.md) for that side of the feature.

## What you get

- Every new spore, session, plan, and graph edge syncs automatically in the background
- Search queries fan out to both local and team data — results merge by relevance, tagged with source
- Team context is additive — if the Worker is slow or unreachable, local results return alone
- One-time backfill pushes each teammate's existing Grove knowledge to the team store on first connect
- Runs on the Cloudflare free tier for small teams

Local Grove databases remain the source of truth — the cloud store is a queryable mirror of connected teammates' Grove data. Nothing is pulled back down. Each record carries a machine identity for attribution.

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

The command outputs a **Worker URL** and **Team key**. Share these with teammates through your preferred out-of-band channel.

The full `myco-team` CLI surface: `install`, `upgrade`, `status`, `rotate-tokens`, `reindex-vectors`, `destroy`.

### 3. Connect teammates

Each teammate opens the **Team** page in their Myco dashboard (`http://localhost:20915/team`, or `myco open` if your install reports a different local URL), pastes the Worker URL and Team key, and clicks **Connect**. Their machine registers with the team and begins syncing immediately.

On first connect, existing local knowledge is backfilled to the team store in batches. New knowledge syncs automatically going forward.

Sync is durable: records are queued, retried, and surfaced on the Team page if an operator needs to retry or discard a stuck item.

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

Independent of Team Sync, Myco creates Grove-scoped backups for resilience. Configure the backup directory on the **Operations** page, or click **Backup Now** for an on-demand backup. Restore supports a dry-run preview, and cross-machine restore preserves attribution so you can pull a teammate's backup file without losing who said what.

Backups include all knowledge tables but exclude logs, tool call activities, and vector embeddings (rebuilt automatically after restore).

## Worker management

### Upgrade

Any team member with Wrangler and `@goondocks/myco-team` installed can update the Worker to match their installed Myco version:

```bash
myco-team upgrade
```

Or click **Update Worker** on the Team page when an update is available. Teammates who already have Team Sync connected can update from the dashboard without installing `myco-team` locally.

The Operations page detects and applies package updates to `@goondocks/myco-team` when that CLI is installed on the same machine. Manual npm updates still work:

```bash
npm update -g @goondocks/myco-team
myco-team upgrade
```

### Architecture

The Worker keeps the cloud side lightweight. Local Grove databases remain the source of truth; the Worker stores a synced mirror for team search and Cloud MCP. Sync is queued and retryable, so transient Cloudflare or network failures do not block local work.

Three surfaces are exposed:

- **Team sync** — connect teammates, receive synced Grove knowledge, and answer team search queries.
- **Operator actions** — show sync status, retry stuck items, discard items you no longer want, and rotate credentials from the Team page.
- **Cloud MCP** — the read-only [Cloud MCP Server](cloud-mcp.md) that cloud agents connect to.

### Cost

A small team (2-5 developers) stays comfortably within the Cloudflare free tier. The $5/month paid tier provides significant headroom if your team outgrows free.

## Dashboard

### Team page

- **Not connected** — setup instructions and connect form (Worker URL + Team key)
- **Connected** — two tabs:
  - **Status** — connection health, team credentials (with show/hide for the Team key), machine identity, MCP endpoint + token + rotate
  - **Sync** — records left to sync, remote delivery depth when queue inspection is configured, failed syncs with **Retry** and **Discard** actions, worker updates, and manual sync
- **Cloud MCP Endpoint** — on the Status tab. Shows the MCP URL, a redacted bearer token, a pre-formatted config snippet for Anthropic Managed Agents, and a "Rotate token" action. See [Cloud MCP docs](cloud-mcp.md).

### Operations page

- Backup directory configuration
- Backup Now button
- Backup history with restore preview
