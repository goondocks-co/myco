# Cloud MCP Server

Expose your project's accumulated intelligence to cloud agents — Anthropic Managed Agents, OpenAI Workflows, N8N, GitHub Copilot agents, and anything else that speaks [Model Context Protocol](https://modelcontextprotocol.io). When [team sync](team-sync.md) is enabled, a read-only MCP server is deployed alongside it on the same Cloudflare Worker and serves your synced knowledge over Streamable HTTP.

## What it does

Cloud agents query the same intelligence your local agents already have — digest extracts, searchable spores, session history, the knowledge graph, and generated skills. Results stay fresh as your team syncs; there's no separate index to manage.

The Cloud MCP server is **read-only by design**. It's a window into project intelligence, not a way to modify it. Local Myco remains the source of truth for writes.

## Tools

Six read-only tools. The Cloud MCP surface follows the local search-then-entity pattern, but only exposes read operations for synced team data.

### Discovery — start here

**`myco_search`** — Semantic and keyword search across synced project knowledge. Returns ranked results with stable IDs, previews, and `retrieve` hints.
- `query` (string, required)
- `types` (string array, optional) — filter to `spores`, `sessions`, `plans`, `skill_records`
- `limit` (number, default 10, max 50)

**`myco_cortex`** — Pre-synthesized project digest at three depth tiers. The fastest way for a cloud agent to understand the project.
- `op` (string, optional) — `digest`
- `tier` (number, optional) — `1500` (executive summary), `5000` (deep onboarding, default), `10000` (comprehensive)

### Detail — retrieve specific items

**`myco_plans`** — List or retrieve synced plans.
- `op` — `list` or `get`
- `id`, `machine_id` for `get`
- `status`, `session`, `limit`

**`myco_sessions`** — List or retrieve synced coding sessions.
- `op` — `list` or `get`
- `id`, `machine_id` for `get`
- `limit` (default 20, max 100), `status`, `agent`, `branch`, `since` (ISO date)

**`myco_skills`** — List or retrieve synced project skills.
- `op` — `list` or `get`
- `id`, `machine_id` for `get`
- `status`, `limit` (default 50, max 100)

**`myco_spores`** — List or retrieve synced spores.
- `op` — `list` or `get`
- `id`, `machine_id` for `get`
- `status`, `observation_type`, `agent_id`, `search`, `limit`, `offset`

## Setting it up

If you've already run `myco-team install`, the Cloud MCP server is deployed automatically the next time you click **Update Worker** in the Team page. New team deployments get it out of the box.

## Finding your endpoint

Open the Myco dashboard → **Team** page. When team sync is connected, a **Cloud MCP Endpoint** section shows:

- The MCP endpoint URL
- The MCP access token (redacted by default; click the eye to reveal, copy button on hover)
- A **Config snippet** button that expands a pre-formatted Anthropic Managed Agent configuration
- A **Rotate token** action

Every connected teammate gets the same endpoint and token automatically — there's nothing to distribute manually across teammates.

## Connecting a cloud agent

### Anthropic Managed Agents

Use the Config snippet from the Team page, or paste this into your agent's `mcp_servers` definition:

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://<your-worker>.workers.dev/mcp",
      "name": "myco",
      "authorization_token": "<MCP_ACCESS_TOKEN>"
    }
  ]
}
```

### N8N, Make, Zapier, and other automation platforms

Configure an MCP server connector with:

- **URL** — `https://<your-worker>.workers.dev/mcp`
- **Transport** — Streamable HTTP
- **Header** — `Authorization: Bearer <MCP_ACCESS_TOKEN>`

### MCP Inspector (for debugging)

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the fastest way to verify your server is working:

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector:
1. Set **Transport Type** to `Streamable HTTP`
2. Set **URL** to your MCP endpoint (from the Team page)
3. Expand **Authentication** → add a custom header `Authorization` with value `Bearer <MCP_ACCESS_TOKEN>` and toggle it on
4. Click **Connect**

You should see `myco` connected and all seven tools listed. Click any tool, fill in its args, and click **Run Tool**.

## Authentication

The Cloud MCP server uses a bearer token distinct from the team sync API key. The token is managed by the Worker, stored encrypted at rest, and distributed automatically to connected teammates. You never need to share it manually — open any teammate's Team page and it's there.

### Rotation

Click **Rotate token** in the Cloud MCP Endpoint section. A confirmation dialog makes the blast radius explicit — rotating invalidates the current token immediately, and every cloud agent currently using it will lose access until you reconfigure them with the new token. Other connected teammates pick up the new token automatically.

## Troubleshooting

**`401 Invalid MCP access token`** — The token in your cloud agent's config doesn't match what the Worker expects. Pull the current token from the Team page and update your agent. If the token was recently rotated, all configured agents need to be updated.

**`401 Missing Authorization header`** — Your cloud agent isn't sending `Authorization: Bearer <token>`. For MCP Inspector, make sure the custom header toggle is enabled.

**Cloud MCP Endpoint section doesn't appear in the Team page** — Myco may still be refreshing the team connection. Wait a few seconds, reopen the Team page, or restart Myco.
