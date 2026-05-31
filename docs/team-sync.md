# Team Sync

Share captured knowledge across your team through a Cloudflare-backed sync layer. Each teammate keeps their local Grove, and Team Sync mirrors your team's knowledge into a shared, queryable store — so everyone's agents draw on the same spores, sessions, plans, and graph without anyone having to think about it.

Team Sync also exposes a secure [Cloud MCP Server](cloud-mcp.md) so cloud agents (Anthropic Managed Agents, n8n, and the like) can read your team's knowledge. See [Cloud MCP](cloud-mcp.md) for that side.

## What you get

- New spores, sessions, plans, and graph edges sync automatically in the background.
- Search fans out across local **and** team knowledge and merges by relevance, tagged with its source.
- Team results are additive — if the team store is slow or unreachable, your local results still return.
- Assigning a project to a team backfills its existing knowledge once; everything after syncs as you work.
- A team roster shows who's connected.
- Runs on the Cloudflare free tier for small teams.

Your local Grove stays the source of truth — the team store is a queryable mirror, and nothing is pulled back down to overwrite local data. Every record is attributed to the machine that created it.

## Set up a team

There are two roles: **one person provisions** the team's cloud infrastructure, and **everyone else joins** with the details that person shares. Only the person provisioning needs Wrangler and the operator CLI — teammates join straight from the dashboard with nothing extra to install.

### 1. Provision the team (one person, once)

Install Wrangler and the operator CLI, sign in to Cloudflare, then create the team with a name:

```bash
npm install -g wrangler @goondocks/myco-team
wrangler login
myco-team install --name "Acme Core"
```

This deploys the team's sync Worker and registers the team on your machine. To serve it from your own domain, add `--domain <your-zone>`. When it finishes, it prints the team's **Worker URL** and **Team key** — share both with your teammates through a private channel. The Team key authorizes writes to the team, so keep it secret.

### 2. Teammates join (everyone, from the dashboard)

Each teammate opens the **Team** page in their Myco dashboard (`http://localhost:20915/team`, or run `myco open`), goes to the **Teams** tab, and under **Join a team** pastes the Worker URL and Team key. That registers the team on their machine — no Wrangler, no operator CLI, nothing else to install.

### 3. Choose which projects sync

On the **Teams** tab, assign each project to a team. A project syncs to exactly one team; leave it unassigned to keep it local. As soon as you assign a project, its existing knowledge backfills to the team store and new knowledge syncs as you work.

Syncing is durable: changes are queued and retried, and anything stuck shows up on the **Sync** tab, where you can retry or discard it.

## What syncs

| Synced | Stays local |
|--------|-------------|
| Spores (observations, wisdom) | Tool-call activity and traces |
| Sessions (metadata, title, summary) | Log entries |
| Prompt batches (prompts, AI summaries) | Attachments (images) |
| Entities and graph edges | Local working buffers |
| Plans and artifacts | |
| Resolution events | |
| Digest extracts | |
| Skills and skill candidates | |
| Team roster (who's connected) | |

Teammates see what was asked and answered — not every file read or shell command. That keeps the team store useful and the cost bounded.

## The Team page

A **team selector** in the top-right scopes what you're viewing to one of your teams. The page has four tabs:

- **Teams** — machine-wide. Join or add a team, see every team registered on this machine, and assign each project to a team. Teams you provisioned also show their one-line update command; teams you only joined show a **Leave team** action.
- **Status** — the selected team's connection health, the Worker URL and Team key to hand to a new teammate, this machine's identity in the team, and the team's [Cloud MCP](cloud-mcp.md) endpoint and token (with a config snippet for cloud agents and a rotate action).
- **Sync** — the selected team's sync health: how much is left to send, failed items with **Retry** and **Discard**, and one-click backfill.
- **Members** — the selected team's roster: every machine connected to the team, with yours marked.

### Leaving a team

To stop syncing to a team, open the **Teams** tab and choose **Leave team**. That removes the team from this machine and clears its pending queue — it does not touch the team's cloud Worker or your local Grove, and other members are unaffected. (To tear the cloud infrastructure down entirely, the operator runs `myco-team destroy --team-id <id>`.)

## Machine identity

Every synced record is tagged with a **machine identity** — a deterministic `{github_username}_{machine_hash}` (e.g. `chris_a7b3c2`). This attributes knowledge to its source and lets you tell "my data" from "team data". It's generated once per machine and cached at `.myco/machine_id`. Nothing to configure.

## Search fan-out

When a project syncs to a team, search hits your local store and the team store in parallel, then merges by relevance. Each result is tagged so you can see where it came from:

- `source: "local"` — from this machine
- `source: "team:chris_a7b3c2"` — from the team store, attributed

If the team store is unreachable within a short timeout, local results return on their own. Team search is always additive, never blocking.

## Cloud embedding alternative

If you'd rather not run Ollama locally for embeddings, point at Cloudflare Workers AI — it uses the same model as the Worker, so embeddings are directly comparable:

```yaml
# myco.yaml
embedding:
  provider: openai-compatible
  model: "@cf/baai/bge-m3"
  base_url: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1
```

Store your Cloudflare API token in `secrets.env`.

## Backup & restore

Independent of Team Sync, Myco creates Grove-scoped backups for resilience. Configure the backup directory on the **Operations** page, or click **Backup Now** for an on-demand backup. Restore supports a dry-run preview, and cross-machine restore preserves attribution, so you can pull a teammate's backup without losing who said what.

Backups include all knowledge but exclude logs, tool-call activity, and vector embeddings (rebuilt automatically after restore).

## Managing the Worker (operators)

The person who provisioned a team manages its Worker. Each team you provisioned shows its update command on the **Teams** tab — copy and run it to redeploy the Worker at your installed Myco version:

```bash
myco-team update --team-id <team-id>
```

The other operator commands take the same `--team-id`: `status`, `rotate-tokens`, `reindex-vectors`, and `destroy`. To update the operator CLI itself:

```bash
npm update -g @goondocks/myco-team
```

The Worker keeps the cloud side lightweight: your local Grove stays the source of truth, the Worker holds a synced mirror for team search and Cloud MCP, and syncing is queued and retryable, so a transient network or Cloudflare hiccup never blocks local work.

### Cost

A small team (2–5 developers) stays comfortably within the Cloudflare free tier. The $5/month paid tier provides significant headroom if your team outgrows it.
