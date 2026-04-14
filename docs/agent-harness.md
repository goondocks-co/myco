# Intelligence Pipeline

Myco runs an intelligence pipeline in the background that reads your captured sessions, extracts observations into the knowledge vault, maintains the graph, and keeps digest extracts fresh. It's fully automatic — once providers are configured, you don't need to trigger it manually. This page covers what it does, what tasks are available, how to configure providers, and how to schedule or disable parts of it.

## What the pipeline produces

- **Spores** — discrete observations extracted from session activity (gotchas, decisions, discoveries, trade-offs, bug fixes, and higher-order wisdom syntheses)
- **Entities and edges** — a knowledge graph linking spores to components, concepts, and people
- **Session titles and summaries** — human-readable labels for every captured session, generated from the actual work done
- **Digest extracts** — pre-computed project context at three depth tiers (1500 / 5000 / 10000 tokens) that get injected at session start
- **Skill candidates** — procedural patterns worth turning into [skills](skills.md) (requires approval)

Every piece of this comes from the same source material: the prompts, tool calls, and assistant summaries captured by the symbiont hooks. Nothing is invented; everything traces back to a session.

## Tasks

Ten tasks cover the full lifecycle. Most users only interact with `full-intelligence` (the default scheduled task) — the others are available for manual trigger or specialized workflows.

### Intelligence

| Task | What it does |
|------|-------------|
| `full-intelligence` | The complete pipeline. Runs on unprocessed batches, extracts spores, maintains the graph, refreshes digests. Scheduled by default. |
| `title-summary` | Generates or updates a session title and summary. Runs automatically after each session turn. |
| `extract-only` | Spore extraction without the graph or digest work. Useful for catching up after a long gap. |
| `review-session` | Deep end-to-end processing of a single session. Trigger from the session detail page. |
| `graph-maintenance` | Entity creation, edge linking, and deduplication pass. |
| `digest-only` | Regenerate digest extracts from the current vault state. |
| `supersession-sweep` | Find and resolve duplicate or contradictory spores. |

### Skill lifecycle

| Task | What it does |
|------|-------------|
| `skill-survey` | Discovers procedural skill candidates from vault knowledge. Runs periodically. |
| `skill-generate` | Generates a validated SKILL.md file from one approved candidate. Runs when approved candidates exist. |
| `skill-evolve` | Monitors active skills for knowledge drift and rewrites stale content. |

See the [Skills docs](skills.md) for the full skill lifecycle.

## Configuring providers

Every task can use a different LLM provider. Configuration is all in `myco.yaml` under the `agent:` key, with a precedence hierarchy from global defaults to per-phase overrides.

### The simplest setup

One provider for everything:

```yaml
agent:
  provider:
    type: anthropic
    model: claude-sonnet-4-6
```

That's it. Every task will use Claude Sonnet via the Anthropic API (or your Claude Code OAuth if you have it).

### Per-task overrides

A common pattern is using a fast local model for lightweight tasks (title generation) and a capable cloud model for the heavy work:

```yaml
agent:
  provider:                          # Global default
    type: anthropic
    model: claude-sonnet-4-6
  tasks:
    title-summary:
      provider:                      # Local model for titles
        type: ollama
        model: granite4:small-h
        context_length: 32768
```

### Supported providers

| Provider | Type string | Notes |
|----------|-------------|-------|
| Anthropic | `anthropic` | Uses your Claude Code OAuth or `ANTHROPIC_API_KEY` |
| Ollama | `ollama` | Local models; specify `base_url` if not on the default port |
| LM Studio | `lmstudio` | Local models via OpenAI-compatible API |

For local providers, set a `context_length` that matches the model's capabilities — Myco uses it to configure the runtime correctly.

### Per-phase overrides (advanced)

For phased tasks like `full-intelligence`, you can override the provider for individual phases. Useful for mixing cloud quality and local cost:

```yaml
agent:
  tasks:
    full-intelligence:
      phases:
        extract:
          provider:
            type: anthropic           # Quality for extraction
            model: claude-sonnet-4-6
        consolidate:
          provider:
            type: ollama              # Local for consolidation
            model: llama3.2
```

## Scheduling

Each task runs on its own schedule. The defaults ship with the built-in task definitions; you override them in `myco.yaml`.

```yaml
agent:
  scheduled_tasks_enabled: true      # Master switch for all scheduled tasks
  event_tasks_enabled: true          # Master switch for event-driven tasks (title-summary)
  tasks:
    full-intelligence:
      schedule:
        enabled: true
        intervalSeconds: 300         # Check for unprocessed batches every 5 min
    skill-survey:
      schedule:
        enabled: true
        intervalSeconds: 600         # Every 10 min when candidates might exist
```

The two master switches (`scheduled_tasks_enabled` and `event_tasks_enabled`) silence the agent without editing per-task config — flip them off when you want the daemon to only capture, without processing.

Tasks only run when the daemon is in an active or idle power state. Background work never fires when the developer has stepped away.

## Triggering tasks manually

From the dashboard's **Operations** page you can kick off any task on demand — useful for catching up after a gap, re-running after a provider change, or testing a new task configuration.

From the CLI:

```bash
myco agent run full-intelligence      # Run the default pipeline now
myco agent run skill-survey            # Survey for new skill candidates
```

## Custom tasks

Drop a YAML task definition into `.myco/tasks/*.yaml` and it'll be loaded at daemon startup alongside the built-ins. Custom tasks have access to the same tool set and the same scheduling options as built-ins. The built-in task definitions are in `packages/myco/src/agent/definitions/tasks/` if you want reference examples.

## Monitoring and troubleshooting

| Command | What it shows |
|---------|--------------|
| `myco stats` | Daemon status, active sessions, database stats |
| `myco doctor` | Health check — vault, DB, providers, agents, daemon |
| `myco logs` | Tail daemon logs |

The dashboard's **Logs** page gives you real-time filtered output if you'd rather read it in the UI. Agent run details (which phases ran, what they produced) live on the **Operations** page.
