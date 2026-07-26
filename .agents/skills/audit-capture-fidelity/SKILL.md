---
name: audit-capture-fidelity
description: "Use when you need to know whether Myco's captured data is correct and complete, rather than why capture stopped — auditing capture fidelity across the Grove database and local symbiont transcripts, checking whether a symbiont's transcript format or hook contract has drifted from its manifest, investigating sessions that never closed or that never appeared at all, reconciling what is on disk against what is in the vault, chasing duplicate or missing prompt batches, NULL content_hash rows, missing response summaries, misclassified prompt origins, or suspected data loss after a coding agent updated. Applies to claude-code, codex, cursor, windsurf, copilot, antigravity, pi, opencode and cline. Use it proactively after any symbiont ships a new version, and before trusting vault contents for analysis. This skill is hand-managed — do NOT register it with the Myco skill pipeline."
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
argument-hint: "[symbiont] | --all | repair <finding-id>"
---

# Audit Capture Fidelity

Answers **"is what we captured correct and complete?"** — a different question from `debug-capture`, which answers "why did capture stop?". Use that skill when data stopped arriving; use this one when data is arriving but you doubt it.

## Routing

- `audit-capture-fidelity <symbiont>` → audit one agent. Start here; most investigations begin with "codex looks wrong".
- `audit-capture-fidelity --all` → every symbiont in the current project's Grove.
- `audit-capture-fidelity repair <finding-id>` → the gated repair flow (`--repair`, dry-run unless `--apply`). Read `references/findings.md` for that id first; most findings are deliberately not repairable and say why.
- No argument → audit the current project's Grove across symbionts that have sessions.

## Why this exists

Capture fidelity has been fixed reactively three times, each after data was already lost. The clearest case: `claude-code.yaml` matched `prompt_starts_with: "<teammate-message "`, Claude Code renamed the tag to `<agent-message from="…">`, and every teammate report silently landed as `origin='human'`. The rule was still valid and matching nothing.

Coding agents ship updates continuously. Every update can quietly invalidate a manifest rule, a parser, or a hook contract. This skill turns that rot into a mechanical check.

## The three layers

Findings name which comparison produced them, because the fixes are unrelated:

| Layer | Comparison | Meaning | Where the fix goes |
|---|---|---|---|
| `drift` | raw transcript vs. package policy | the agent changed; our manifest/parser no longer matches it | manifest rule or parser |
| `pipeline` | package policy vs. vault rows | we knew to capture it and didn't | hooks, daemon, mining |
| `integrity` | vault vs. itself | invariants violated inside the database | writer path |

## STOP — the by-design traps

**Myco has several places where two behaviors are both correct. A naive audit reports the second as a bug.** Three of the four below were written into an earlier draft of this work as findings before being caught. Do not "fix" any of these:

| Axis | Mode A | Mode B | The wrong conclusion |
|---|---|---|---|
| Capture model | hook + transcript mining | **plugin-reported** (pi, opencode, cline) | "NULL transcript_path = data loss" |
| Session closure | exit hook (claude-code, cursor, copilot) | **stale sweep** (codex, windsurf, antigravity, pi, opencode, cline) | "session stuck active" |
| Sub-agent threads | own session | **reattributed to the parent** | "child transcript has no session row" |
| Manifest drop rules | captured | **deliberately dropped** (`codex exec`, ephemeral sub-invocations) | "transcript on disk was never captured" |

The audit encodes all four. If you find yourself adding a check, confirm it can tell the modes apart — and if it cannot, make it report a coverage gap instead of a finding. **A check that cannot discriminate must not report.**

Corollary: for pi, opencode and cline, an empty `transcript_path` is correct. `opencode/plugin.ts` says so directly: *"Opencode has no on-disk transcript for Myco to mine."*

## Running it

```bash
# whole grove
bun scripts/capture-audit.ts --grove ~/.myco/groves/<groveId>/myco.db

# one project, one symbiont
bun scripts/capture-audit.ts --grove <db> --project proj_<id> --symbiont codex

# machine-readable
bun scripts/capture-audit.ts --grove <db> --json
```

Must run under **bun**, not tsx — the audit uses `bun:sqlite`. With no `--grove` it discovers groves under `MYCO_HOME`, `~/.myco` and `~/.myco-dev`; be explicit about which you mean when dogfooding, since dev and prod hold different data.

The audit is **read-only by construction** — it opens the vault through `openReadonly`, so no check can mutate a vault even if it is buggy.

## Reading the report

Three sections, in priority order.

**1. ACTIVE vs LEGACY.** This is the first thing to look at, because it changes what you are deciding:

- `LEGACY` — stopped occurring. Bounded cleanup; repairing the backlog is genuinely finished work.
- `ACTIVE` — still occurring. **Repairing rows here masks an open bug.** Fix the code path first, then repair.
- `UNCLASSIFIED` — no timestamps to date it. Investigate before acting.

The audit reports the cutoff date but never claims which release caused it. Attributing a cutoff to a shipped fix is your judgment, not the tool's.

**2. NOT COVERED.** Read this before treating anything as clean. It lists every place the audit deliberately did not look or could not conclude — a symbiont whose transcripts carry no working directory, an enumeration that hit its cap, a plugin-reported agent with nothing to reconcile. **An audit that silently skips a symbiont reads as a clean bill of health for it, which is worse than saying nothing.**

**3. Findings.** Severity-ordered. Each carries a stable id — look it up in `references/findings.md`.

## Diagnosing a finding

`references/findings.md` gives each finding id: what it means, candidate root causes, **the observation that discriminates between them**, the fix pattern, and the gate that closes it.

Step 3 is the load-bearing one. Candidate causes usually look identical in the database. The closure checks are the model: `closure-sweep-missed` and `closure-sweep-not-running` are the same rows, separated by one question — *did the maintenance sweep actually run?* One is a bug in the sweep; the other is a job that never fired, because `SESSION_MAINTENANCE` is a PowerManager job registered `runIn: ['active','idle','sleep']` and fires on power-state transitions, not a wall clock.

Do not guess between candidates. Gather the discriminating evidence.

For per-agent quirks — transcript format oddities, known payload divergences, hand-verification recipes — see `references/symbionts/<name>.md`. Those files hold **only what a manifest cannot express**; anything declared in the manifest is read from the manifest at runtime and must not be duplicated there.

## Repair — where you stop and ask

Repair is separate from audit and never runs automatically.

| Step | Gate |
|---|---|
| Audit → report | none, read-only |
| Repair | **STOP** — show the dry run and the exact rows; get explicit approval |
| Repair >100 rows, or a finding class not seen before | **STOP** — itemise and re-confirm |
| Re-run audit to prove the finding cleared | none |
| Harden: root cause → regression gate | **STOP** — the human approves the gate before it is committed |

```bash
bun scripts/capture-audit.ts --grove <db> --repair session-counter-drift          # dry run
bun scripts/capture-audit.ts --grove <db> --repair session-counter-drift --apply  # writes
```

**Repairable today:** `session-counter-drift` only — it recomputes a denormalised counter from the rows it summarises, which is derivable with no judgment involved.

**Refused, each with a stated reason** rather than silently ignored: `batch-null-content-hash` (the hash needs an ordinal whose live-path derivation `batches.ts` says is invalid for backfill — a wrong dedup key is worse than a NULL one), `batch-missing-response` and `transcript-never-captured` (both are re-mines, not column updates), `envelope-classified-human` (needs a per-tag origin decision, which belongs in a manifest rule), `batch-orphaned` (the only mechanical fix would be deletion).

**Never, under any circumstances:** `DELETE` anything; rewrite `user_prompt` or captured content; change `sessions.id` or foreign keys; write to a Grove other than the one named on the command line. Data preservation is Myco's core contract — a repair that loses data is worse than the finding it fixed.

A `.bak` of the vault is taken automatically before the first write.

## Hardening — a finding is not closed by repairing rows

**It is closed when a test or invariant fails if the class returns.** Repair alone just resets the clock; that is precisely how the earlier drift instances recurred after being fixed by hand.

Each confirmed root cause ships with one of:

- a unit test in `tests/capture/`;
- a manifest rule keyed on a **structural** signal rather than a literal prefix — literals are what rot;
- a gate in `tests/symbionts/transcript-discovery-manifests.test.ts` when the cause is a manifest declaration.

If you cannot name the gate, you have not finished the finding.

## Extending the audit

Checks live in `packages/myco/src/capture/audit/`, not in this skill. Logic belongs in the package where `npm test` covers it — a script inside a skill directory cannot have a regression gate, which would contradict the rule above.

Two constraints when adding a check:

1. **Never re-implement capture policy.** Import the real parsers, `TranscriptMiner`, `evaluateUserPromptRules`, `evaluateSessionCaptureRules`, `resolveSubagentThread`. The package is the only source of truth for what should be captured; the audit only compares. A check that forms its own opinion will disagree with production and manufacture findings.
2. **Declare, don't hardcode.** Agent-specific paths belong in `capture.transcriptDiscovery` in the manifest. No agent-specific path may appear in the audit module or in this skill.

## Related skills

- `debug-capture` — capture went silent; walks the lifecycle top-down.
- `stop-hook-fragility` — the Stop hook dropped a response.
- `capture-pipeline-durability` — building resilient capture.
- `vault-schema-migration` — if a fix needs a schema change.
