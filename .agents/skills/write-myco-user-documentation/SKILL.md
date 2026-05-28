---
name: myco:write-myco-user-documentation
description: "Use this skill when writing, reviewing, or editing user-facing Myco documentation — README sections, feature docs, onboarding guides, CLI reference pages, docs site SEO/crawler files, or any content intended for people who use Myco (not people who build it). Activate this skill even if the user doesn't explicitly ask for a documentation review — if you're finishing a feature implementation and documentation is the next step, invoke this skill before writing or committing any docs. This skill enforces the Myco doc-voice contract: user guides rather than user manuals, capability-first language, zero internal mechanics leakage, crawler-friendly public docs, and user-vocabulary only."
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Write Myco User Documentation

Myco documentation has a strict voice contract: every sentence answers "what can the user do?" not "how does the system work?" This skill is a pre-ship gate — run it before any user-facing docs land in a PR. Violations of this contract have been caught and corrected repeatedly across feature branches, so enforce the gate proactively.

## Prerequisites

- Implementation is complete (or nearly complete). Documentation written mid-implementation often describes what was built rather than what the user needs to know.
- You know the intended audience: Myco users (people running `myco` commands and working with the vault and agent pipeline), not Myco contributors (people modifying the source).

## Steps

### 1. Identify audience and scope

Ask: *Who reads this?* User-facing docs appear in:
- `README.md` or `docs/` — general users
- Feature onboarding sections — users adopting a specific feature
- CLI `--help` text — users at the terminal

Design specs (`docs/superpowers/specs/`), commit messages, and CHANGELOG entries are **not** user-facing docs. This skill does not apply to those artifacts.

### 2. Write guides, not manuals

Default to **user guides**, not user manuals. A guide helps the user accomplish a real outcome in the order they are likely to need it. A manual exhaustively catalogs the system. Myco public docs should read like guides unless the page is explicitly a reference page.

| Prefer | Avoid |
|---|---|
| Outcome-first sections: install, configure, connect, verify, recover | Implementation catalogs and subsystem inventories |
| Scenario flow: "If you want Team Sync, do this" | Abstract capability lists without an adoption path |
| Progressive disclosure: start with the happy path, then troubleshooting | Front-loading edge cases, internals, or historical migrations |
| User-facing names from the UI/CLI | Codebase names, file ownership, table names, or daemon internals |

Reference docs are allowed when the user is intentionally looking something up, such as CLI commands, MCP tools, config fields, or install scripts. Even then, introduce the reference with a short guide paragraph that says what the user can do with it.

### 3. Draft capability-first

Every sentence should start from the user's perspective. The mental model: *"The user can ___."*

```
❌ "The init command triggers SymbiontInstaller which writes hook templates
    and configures myco.yaml."

✅ "Run `myco init` to set up Myco in your project. It creates the config
    file and installs the agent hooks automatically."
```

Lead with the user action, then the outcome. Mechanism comes last — or not at all.

### 4. Strip internal mechanics

Read each paragraph and remove any sentence that:
- Names internal classes (`SymbiontInstaller`, `PowerManager`, `DaemonClient`, `outbox`)
- Describes implementation steps invisible to the user
- References internal architecture (schema versions, database tables, provisioning sequences)

**Keep a detail only if** removing it would leave the user unable to debug a failure or make an informed choice. For example, "Myco stores vault data in `.myco/`" is user-relevant even though `.myco/` is an internal directory.

> **Gotcha — internal vocabulary leakage**: Terms like "spore," "symbiont," and "vault" appear in the Myco UI and CLI output — they are user vocabulary. Terms like "outbox," "PowerManager," "SymbiontInstaller," and "schema version" are codebase vocabulary. Never use codebase vocabulary in user docs.

### 5. Generalize patterns — don't enumerate variants

Describe the rule once with one canonical example. Enumerations go stale and bloat docs.

```
❌ "Supported agents: Claude Code, Copilot CLI, Gemini CLI, opencode,
    Cursor, Windsurf."

✅ "Myco works with any AI coding agent that supports hook scripts.
    Claude Code, Copilot CLI, and Gemini CLI are supported out of the box."
```

### 6. Write in present tense, not change-voice

User docs describe the *current state* of the tool. They do not describe what changed in this release, why a design decision was made, or what the previous behavior was.

If you catch yourself writing "now supports," "we've added," or "previously," rewrite in present tense describing the capability as it exists today.

> **Gotcha — commit message creep**: It's easy to write docs that read like a commit message, especially immediately after implementing a feature. Step back and describe the tool as if the user is encountering it for the first time.

### 7. Document multi-symbiont vault usage patterns

When documenting features that work across multiple AI agents in a project, emphasize the vault as the shared memory system and document the saving requirements:

```
❌ "Save insights to your agent's memory file."

✅ "Save project insights to the Myco vault so all agents in your
    workspace can access them. Use individual agent memory only
    for session-specific notes."
```

Document the requirement that all agents in a multi-symbiont setup must save to the shared vault:

```
✅ "When working with multiple agents in one project, ensure each
    agent saves important insights to the shared Myco vault.
    This keeps project knowledge accessible to all team members
    regardless of which agent they're using."
```

Document skill discovery and layout patterns that users encounter:

```
✅ "Skills are stored in `.agents/skills/` with a `SKILL.md` file.
    Run `myco skills list` to see available skills in your project.
    Skill directories use kebab-case names and contain symlinks
    that allow agents to discover and load them automatically."
```

### 8. Document Three-Surface Rule for user-facing content

Myco documentation is consumed across three surfaces: code comments, CLI help, and narrative docs. Apply consistent capability-first voice across all three:

- **Code comments** (for future maintainers): Explain *what* capability the code provides and *why* it was designed this way.
- **CLI help text** (for interactive users): Answer "what does this command do right now?" in present tense.
- **Narrative docs** (for onboarding): Walk users through capability with examples and preconditions.

The voice contract applies equally across all three surfaces. When documenting a feature:
```
✅ Code comment: "Validates that vault contains required spore indices for query optimization"
✅ CLI help: "Search the vault by spore type and text content"
✅ Narrative doc: "Run `myco search spore discovery` to find recent discoveries about the codebase"
```

Never leak implementation detail in any surface. All three should be readable by users who don't understand the system architecture.

### 9. Document CLI help and command patterns

When writing CLI help text or documenting command usage, follow consistent patterns that match user expectations:

```
✅ "Use `myco help <command>` to see detailed options for any command.
    All Myco commands support `--help` for quick reference."
```

Document auto-completion and discovery features:

```
✅ "Myco commands provide tab completion in most shells.
    Run `myco --help` to see all available commands."
```

### 10. Ensure legal/IP clarity in public messaging

When writing public-facing content that references Myco's relationship to other tools or projects, be precise about intellectual property boundaries:

```
❌ "OAK is now Myco" or "OAK became Myco"
    (implies continuity/transfer that may have legal implications)

✅ "Myco is a project intelligence system" or "Myco captures your development work"
    (describes Myco independently without claiming lineage)
```

If mentioning predecessor tools is necessary for context, frame it as user migration rather than project evolution:

```
✅ "Users migrating from OAK can import their activity history with `myco migrate`"
```

### 11. Keep public docs discoverable

When editing the public docs site (`docs/index.html`, top-level files under `docs/`, README content that should be discoverable, or install pages), preserve both traditional search and AI-search readability.

Required checks for public docs changes:

- The homepage has a clear `<title>`, meta description, canonical URL, Open Graph tags, Twitter card tags, and JSON-LD structured data.
- `docs/robots.txt` allows public crawling and points to `https://myco.sh/sitemap.xml`.
- `docs/sitemap.xml` lists the homepage and core user guides on `https://myco.sh/`, not only GitHub URLs.
- `docs/llms.txt` gives LLMs a concise project summary and curated links to the highest-signal user guides.
- The docs homepage links to local `myco.sh/*.md` guide URLs where possible. Use GitHub links for source code, issues, releases, and repository context, not as the primary path for user guides.
- Do not include internal plans, design specs, scratch docs, or `docs/superpowers/` content in sitemap or `llms.txt`.

AI-readable docs are still user docs. Do not make `llms.txt` a keyword dump or implementation catalog. Keep it concise, current, and aligned with the public product framing.

### 12. Apply the voice checklist

After drafting, read each paragraph through this gate:

| Question | Keep if yes | Rewrite if no |
|---|---|---|
| Does this tell the user what they can do? | ✅ | Rewrite capability-first |
| Is this a guide when the user needs a guide, rather than a manual? | ✅ | Reframe around outcomes and adoption flow |
| Is every term user-vocabulary (appears in UI/CLI output)? | ✅ | Replace with user term or remove |
| Does this describe current state, not past changes? | ✅ | Rewrite in present tense |
| Could a user act on this information directly? | ✅ | Consider removing |
| If public, is it discoverable through metadata, sitemap, and `llms.txt` where appropriate? | ✅ | Update the public crawler surfaces |
| Are any IP/legal claims clear and accurate? | ✅ | Clarify relationships and boundaries |

### 13. Add docs to the PR as the final step

Documentation is a merge gate, not a mid-implementation artifact. Write docs after implementation is complete and review them with fresh eyes — ideally after stepping away from the implementation context.

> **Gotcha — implementation drift**: Documentation written during implementation tends to describe what was built rather than what the user needs to know. Internal details feel relevant when the code is fresh in your mind — they aren't to the user. Always do a final doc-voice pass after the code is done.

## Before / After Example

**Feature**: Cloud MCP server connection

```
❌ Before (implementation voice):
"The cloud MCP server establishes a persistent WebSocket connection via
the DaemonClient and provisions credentials through the outbox pipeline.
Tokens are stored in .myco/secrets.env after the handshake completes."

✅ After (user voice):
"Connect Myco to the cloud MCP server by running `myco connect`. Your
credentials are stored securely in `.myco/secrets.env` — you only
need to do this once per project."
```

## What This Skill Does Not Cover

- **Writing SKILL.md files** — use the `myco:write-myco-skill` skill instead
- **Design specs and internal architecture docs** — those live in `docs/superpowers/specs/` and follow different norms
- **CHANGELOG and release notes** — those are intentionally change-voice, not capability-voice
