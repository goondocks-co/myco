---
name: myco:write-myco-user-documentation
description: |
  Use this skill when writing, reviewing, or editing user-facing Myco documentation
  — README sections, feature docs, onboarding guides, CLI reference pages, or any
  content intended for people who *use* Myco (not people who build it). Activate
  this skill even if the user doesn't explicitly ask for a documentation review —
  if you're finishing a feature implementation and documentation is the next step,
  invoke this skill before writing or committing any docs. This skill enforces the
  Myco doc-voice contract: capability-first language, zero internal mechanics leakage,
  and user-vocabulary only.
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

### 2. Draft capability-first

Every sentence should start from the user's perspective. The mental model: *"The user can ___."*

```
❌ "The init command triggers SymbiontInstaller which writes hook templates
    and configures myco.yaml."

✅ "Run `myco init` to set up Myco in your project. It creates the config
    file and installs the agent hooks automatically."
```

Lead with the user action, then the outcome. Mechanism comes last — or not at all.

### 3. Strip internal mechanics

Read each paragraph and remove any sentence that:
- Names internal classes (`SymbiontInstaller`, `PowerManager`, `DaemonClient`, `outbox`)
- Describes implementation steps invisible to the user
- References internal architecture (schema versions, database tables, provisioning sequences)

**Keep a detail only if** removing it would leave the user unable to debug a failure or make an informed choice. For example, "Myco stores vault data in `.myco/`" is user-relevant even though `.myco/` is an internal directory.

> **Gotcha — internal vocabulary leakage**: Terms like "spore," "symbiont," and "vault" appear in the Myco UI and CLI output — they are user vocabulary. Terms like "outbox," "PowerManager," "SymbiontInstaller," and "schema version" are codebase vocabulary. Never use codebase vocabulary in user docs.

### 4. Generalize patterns — don't enumerate variants

Describe the rule once with one canonical example. Enumerations go stale and bloat docs.

```
❌ "Supported agents: Claude Code, Copilot CLI, Gemini CLI, opencode,
    Cursor, Windsurf."

✅ "Myco works with any AI coding agent that supports hook scripts.
    Claude Code, Copilot CLI, and Gemini CLI are supported out of the box."
```

### 5. Write in present tense, not change-voice

User docs describe the *current state* of the tool. They do not describe what changed in this release, why a design decision was made, or what the previous behavior was.

If you catch yourself writing "now supports," "we've added," or "previously," rewrite in present tense describing the capability as it exists today.

> **Gotcha — commit message creep**: It's easy to write docs that read like a commit message, especially immediately after implementing a feature. Step back and describe the tool as if the user is encountering it for the first time.

### 6. Ensure legal/IP clarity in public messaging

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

### 7. Apply the voice checklist

After drafting, read each paragraph through this gate:

| Question | Keep if yes | Rewrite if no |
|---|---|---|
| Does this tell the user what they can do? | ✅ | Rewrite capability-first |
| Is every term user-vocabulary (appears in UI/CLI output)? | ✅ | Replace with user term or remove |
| Does this describe current state, not past changes? | ✅ | Rewrite in present tense |
| Could a user act on this information directly? | ✅ | Consider removing |
| Are any IP/legal claims clear and accurate? | ✅ | Clarify relationships and boundaries |

### 8. Add docs to the PR as the final step

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