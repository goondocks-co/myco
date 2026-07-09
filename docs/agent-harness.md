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

Fifteen tasks cover the full lifecycle. Most users only interact with `vault-evolve` (the default scheduled task) or `vault-seed` (a one-shot for brownfield repos) — the others are available for manual trigger or specialized workflows.

### Intelligence

| Task | What it does |
|------|-------------|
| `vault-evolve` | The complete pipeline. Runs on unprocessed batches, extracts spores, consolidates wisdom, refreshes digests. Scheduled by default. |
| `vault-seed` | One-shot manual seeding for brownfield codebases — explores the repo with filesystem + grep tools and creates the initial spore set and digest. |
| `title-summary` | Generates or updates a session title and summary. Runs automatically after each session turn. |
| `extract-only` | Spore extraction without the digest work. Useful for catching up after a long gap. |
| `review-session` | Deep end-to-end processing of a single session. Trigger from the session detail page. |
| `digest-only` | Regenerate digest extracts from the current vault state. |
| `supersession-sweep` | Find and resolve duplicate or contradictory spores. |

`vault-seed` is safe to re-run. It checks the vault first and, if a prior seeding pass already populated it, exits after a brief check instead of creating duplicate spores — so re-triggering it by accident (or running it again after a partial failure) costs a few cents rather than a full pass. A full pass over a mid-sized codebase runs a few dollars and several minutes; the re-seed check itself completes in seconds.

### Cortex injection

| Task | What it does |
|------|-------------|
| `cortex-instructions` | Generate the per-project instructions block that ships with the session-start digest. |
| `cortex-prompt-builder` | Build the per-prompt spore injection payload. |

### Canopy

| Task | What it does |
|------|-------------|
| `canopy-describe` | Generate the optional one-line LLM descriptions for Canopy entries. |
| `canopy-map` | Synthesize and refresh the project map. |

See [Canopy](canopy.md) for what these produce.

### Skill lifecycle

| Task | What it does |
|------|-------------|
| `skill-survey` | Discovers procedural skill candidates from vault knowledge. Runs periodically. |
| `skill-generate` | Generates a validated SKILL.md file from one approved candidate. Runs when approved candidates exist. |
| `skill-evolve` | Monitors active skills for knowledge drift and rewrites stale content. |

See the [Skills docs](skills.md) for the full skill lifecycle.

### OKF

| Task | What it does |
|------|-------------|
| `okf-synthesize` | Synthesizes the project's [OKF](okf.md) knowledge wiki — a curated set of topic pages — when the project has meaningfully changed. Only runs when OKF is enabled for the project; a precondition check skips the run when nothing has changed since the last refresh. |

See [OKF](okf.md) for the repository-carried wiki this task keeps fresh.

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

For phased tasks like `vault-evolve`, you can override the provider for individual phases. Useful for mixing cloud quality and local cost:

```yaml
agent:
  tasks:
    vault-evolve:
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
    vault-evolve:
      schedule:
        enabled: true
        intervalSeconds: 300         # Check for unprocessed batches every 5 min
    skill-survey:
      schedule:
        enabled: true
        intervalSeconds: 600         # Every 10 min when candidates might exist
```

For capture-only projects, leave the project capability toggles off. Myco still captures sessions and keeps search available, while heavier intelligence work such as Vault Evolution, Canopy mapping, and skill lifecycle tasks stays off. Canopy context injection follows the Canopy capability for each project. See [Grove Management](groves.md) for the user-facing guide to project capabilities.

Tasks only run when Myco is active or recently active. Background work pauses when the developer has stepped away.

## Triggering tasks manually

From the dashboard's **Operations** page you can kick off any task on demand — useful for catching up after a gap, re-running after a provider change, or testing a new task configuration.

From the CLI:

```bash
myco task run vault-evolve       # Run the default pipeline now
myco task run skill-survey       # Survey for new skill candidates
```

`myco agent --task <name>` is the equivalent lower-level form. Use
`myco task run <name>` when you want the task-oriented CLI surface, including
`--dry-run`.

## Custom tasks

Drop a YAML task definition into `.myco/tasks/*.yaml` and it'll load alongside the built-ins on restart. Custom tasks have access to the same tool set and scheduling options as built-ins. The built-in task definitions are in `packages/myco/src/agent/definitions/tasks/` if you want reference examples.

Example one-shot recipe: [`docs/examples/skill-decontaminate.yaml`](examples/skill-decontaminate.yaml) cleans up older generated skills whose live procedural prose contains point-in-time release, PR, date, session, or decision-state artifacts.

## Monitoring and troubleshooting

| Command | What it shows |
|---------|--------------|
| `myco stats` | Service status, active sessions, database stats |
| `myco doctor` | Health check — data, providers, agents, service |
| `myco logs` | Tail service logs |

The dashboard's **Logs** page gives you real-time filtered output if you'd rather read it in the UI. Agent run details (which phases ran, what they produced) live on the **Operations** page.
