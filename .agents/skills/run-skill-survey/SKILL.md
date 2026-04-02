---
name: myco:run-skill-survey
description: Use this skill when you need to run the Myco skill-survey agent task to surface new skill candidates from accumulated vault knowledge — or when you need to review, approve, or dismiss candidates that the survey has already produced. Activate even if the user doesn't explicitly say "skill-survey" — any time they ask "what skills should we add," "why aren't there more skills," "the Skills dashboard is empty," or "how do I get the agent to generate skills," this procedure applies. Also relevant when the survey has run but produced zero candidates, when candidates have piled up awaiting review, or when a previously dismissed candidate should be reconsidered.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Running the Skill Survey to Identify and Review Candidates

## Overview

The skill survey scans accumulated vault spores and sessions to identify topics that could become reusable skills. It runs **automatically in the background** during idle time — you do not need to trigger it manually. Results appear in the Skills dashboard as **candidates** awaiting review.

**Critical scheduling fact:** `skill-survey` is `enabled: true` by default and auto-runs during idle. The downstream tasks (`skill-generate` and `skill-evolve`) are `enabled: false` by default and require explicit opt-in via the Agent Tasks page. This means candidates will accumulate passively, but skills will **not materialize** until you enable `skill-generate`. This is by design — the system lets evidence accumulate before prompting you to act.

## Prerequisites

- Myco daemon running
- At least one session with processed vault data (spores visible in Daemon UI → Sessions)
- Access to Daemon UI → Skills and Daemon UI → Agent Tasks

## Steps

### 1. Check the Skills Dashboard

Navigate to **Daemon UI → Skills**. The page shows two sections:
- **Skill Candidates** — topics the survey has identified, pending your review
- **Active Skills** — SKILL.md files that have already been generated

If the page is empty, click the **HelpCircle** button in the page header for a full pipeline orientation, including links to Agent Tasks for enabling downstream tasks. Contextual empty-state messages in each list also explain what to do next.

### 2. Verify the Survey Is Running

If you see zero candidates and expected more:

1. Go to **Daemon UI → Agent Tasks**
2. Find `skill-survey`
3. Confirm `enabled: true` — it should be on by default
4. Check last run time; if it has never run, the vault may still be too sparse

The survey runs during idle periods, processing batches of vault knowledge. It may take a few sweeps to surface candidates for a newly populated vault.

### 3. Trigger a Manual Run (Optional)

To run the survey immediately rather than waiting for the next idle sweep:

1. Go to **Daemon UI → Agent Tasks**
2. Find `skill-survey`
3. Click **Run Now**

New candidates will appear in the Skills dashboard within minutes.

### 4. Review Candidates

In the Skills dashboard → **Skill Candidates**, for each candidate:

- **Approve** — queues the candidate for skill generation (requires `skill-generate` to be enabled separately)
- **Dismiss** — marks it as not worth a skill

Review criteria:
- Does it represent a reusable procedure, not a one-off fix?
- Is it specific and actionable?
- Is it distinct from existing skills?

### 5. Understand Why Approved Candidates Don't Become Skills

Approving a candidate does not immediately create a skill. `skill-generate` must be **explicitly enabled** via Agent Tasks. This is the most common reason a healthy candidate queue produces no skills. Navigate to Agent Tasks → `skill-generate` → toggle enabled on.

### 6. Recover a Dismissed Candidate

Dismissed candidates are retained in the vault, not deleted. To reconsider one:

```
vault_skill_candidates(action: "list", status: "dismissed")
vault_skill_candidates(action: "update", id: "<id>", status: "identified")
```

The candidate returns to the pending queue and can be approved normally.

## Common Pitfalls

**Candidates accumulate but no skills appear**
Root cause: `skill-generate` is `disabled` by default. This is intentional — the generative step is opt-in until you trust the output. Enable it via Daemon UI → Agent Tasks → `skill-generate`.

**Survey returns zero candidates despite many sessions**
- The survey uses a threshold; a sparse vault may legitimately return zero results
- Verify `skill-survey` is enabled and has run at least once (check Agent Tasks last-run timestamp)
- Ensure vault spores exist: check Daemon UI → Sessions and confirm spores are listed

**Skills dashboard completely empty on first use**
Use the persistent HelpCircle dialog (always visible in the page header) for pipeline orientation. Empty-state messages in the Candidate List and Skill List link directly to Agent Tasks for enablement.

**Survey is running but candidates never appear for a known topic**
The survey detects clusters; isolated single-session knowledge won't surface as a candidate until related spores appear across multiple sessions. Keep dogfooding — the vault will reach threshold naturally.
