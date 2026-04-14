---
name: myco:session-lifecycle-and-gating
description: |
  Use this skill whenever you are working with Myco session lifecycle,
  state transitions, or the intelligence-task query gate — even if the
  user does not explicitly mention session gating. This covers: the
  session state machine (active → completed → active reactivation path)
  and settlement timing; safely adding new session completion paths by
  routing through triggerTitleSummary(); verifying that every vault read
  surface honors requireSettledSessions; configuring settledSessionIdleMinutes
  and requireSettledSessions in myco.yaml; and ensuring new intelligence
  tasks inherit the gate. Apply any time you touch session completion,
  session queries, or new intelligence task types.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Session Lifecycle and Query-Layer Gating

Sessions in Myco pass through a defined state machine enforced by the daemon. The intelligence-task gate (`requireSettledSessions`) prevents in-flight transcript data from contaminating agent outputs. Both the state machine and the gate have invariants that must be honored whenever you add a new completion path, a new query surface, or a new intelligence task type.

## Prerequisites

- Understand the Myco daemon architecture: the daemon runs jobs and reacts to hooks. Session state is stored in SQLite.
- Know the two session-related config keys in `myco.yaml` under the `agent:` section:
  - `requireSettledSessions` — boolean; enables the intelligence-task gate
  - `settledSessionIdleMinutes` — integer; idle threshold (default: 30 minutes)
- Have daemon source open. Key locations: the session-maintenance job, the sessions API route, and the hook handler for `SessionStart`/`SessionEnd`.

## Procedure 1: Understanding the Session State Machine

Sessions follow a linear state machine with one reactivation path:

```
active  ──(SessionEnd hook or idle threshold)──►  completed
  ▲                                                    │
  └──────────(SessionStart on same session)────────────┘
             (reactivates: status flips back to 'active')
```

**Settlement conditions** — a session is considered settled when either:
1. A `SessionEnd` hook fires for that session, OR
2. `last_prompt_at` is older than `settledSessionIdleMinutes` (default: 30 minutes)

The session-maintenance job runs periodically and completes sessions that meet condition 2. The `SessionEnd` hook fires when the user closes the coding-agent window.

**Reactivation invariant** — when `SessionStart` fires on a session that is already `completed`, the daemon MUST flip `status` back to `'active'`. This is non-negotiable: if a completed session is not reactivated, all of its new prompts become invisible to query surfaces that filter for settled data. The gate then silently drops live data — prompts arrive under a session that immediately re-completes on the next maintenance cycle.

Verify reactivation logic exists in the `SessionStart` handler:

```bash
grep -n "SessionStart\|reactivat\|status.*active" src/daemon/hooks/*.ts
```

## Procedure 2: Adding a New Session Completion Path Safely

Any code path that completes a session must route through the shared `triggerTitleSummary()` helper. This is the single chokepoint that enforces `requireSettledSessions` behavior. Duplicating the gate check inline will drift from config changes and will not inherit future gate improvements.

**When to apply**: you are adding a new API endpoint, UI action, CLI command, or automation trigger that marks a session as completed.

**Steps:**

1. Locate the canonical `triggerTitleSummary()` implementation:
   ```bash
   grep -rn "triggerTitleSummary" src/
   ```

2. In your new completion path, call `triggerTitleSummary(sessionId)` *after* persisting `status: 'completed'` to SQLite — never before. The helper reads session state.

3. Do NOT copy-paste gate logic from another route. The helper owns the gate logic.

4. Use the manual complete API as your reference implementation — it was the canonical example where `triggerTitleSummary()` was initially missed and then fixed:
   ```bash
   grep -n "complete\|triggerTitleSummary" src/daemon/routes/sessions.ts
   ```
   The `POST /api/sessions/:id/complete` route is the before/after reference.

5. Write a test that completes a session via your new path with `requireSettledSessions: false` and confirms title/summary generation fires.

**Gotcha**: Inline gate logic (`if (!config.requireSettledSessions) triggerTitle()`) will silently diverge the next time the helper's semantics change. The helper is the contract.

## Procedure 3: Verifying Gate Completeness Across Read Surfaces

The `requireSettledSessions` gate must be honored by **every** vault read surface. A gate applied to only some query paths creates split-brain: the agent sees settled data from one tool and in-flight data from another.

**The complete list of surfaces that must honor the gate:**

| Surface | Description |
|---------|-------------|
| `vault_unprocessed` | Prompt batches — must exclude active sessions |
| `vault_spores` | Spore queries — must filter by session settlement state |
| `vault_sessions` | Session list — must omit active sessions |
| `vault_search_fts` | Full-text search — must exclude active-session content |
| `vault_search_semantic` | Semantic search — must exclude active-session embeddings |

PR #72 shipped the gate for `vault_unprocessed`, `vault_spores`, and `vault_sessions` but initially missed `vault_search_fts` and `vault_search_semantic`. The two search surfaces were gated only after the gap was discovered post-merge.

**Steps for verifying a new read surface:**

1. Locate the SQL query or data-fetch path for the new surface:
   ```bash
   grep -rn "vault_search\|vault_spores\|FROM sessions" src/daemon/tools/*.ts
   ```

2. Confirm the query has a `WHERE` clause or join that restricts to settled sessions. The canonical settlement predicate looks like:
   ```sql
   WHERE s.status = 'completed'
      OR s.last_prompt_at < datetime('now', '-' || :idleMinutes || ' minutes')
   ```
   If this join or subquery is absent, the surface bypasses the gate.

3. Add the settlement filter using the same SQL fragment as the existing gated surfaces — copy it rather than writing a new predicate, so all surfaces stay in sync.

4. Verify with an integration test: create an active session with content, enable `requireSettledSessions: true`, query the surface, confirm the active session's content does not appear.

5. Add the new surface to the table above so future completeness checks include it.

**Gotcha**: Search surfaces are the most commonly missed. Search feels "read-only" and low-stakes, but if an agent runs semantic search over an active session's spores it can act on mid-session data. Both FTS and semantic search must be gated.

## Procedure 4: Configuring and Extending Intelligence Task Gating

The gate configuration lives in `myco.yaml` under the `agent:` key:

```yaml
# myco.yaml
agent:
  requireSettledSessions: true      # boolean; disable for dev/test only
  settledSessionIdleMinutes: 30     # integer minutes; default 30
```

**When to set `requireSettledSessions: false`:**
- Local development and testing where you inject synthetic session data
- CI environments where you control session state directly

**When to keep it `true` (production default):**
- Any deployment where the coding agent is actively running. Active sessions generate in-flight fragments that are not yet coherent intelligence input.

**Adding a new intelligence task that must inherit the gate:**

Any task that analyzes transcript semantics (e.g., a custom analysis task, a new variant of `skill-survey`) must check `requireSettledSessions` before reading session content.

1. At the start of the task's execution logic, read the config and enforce the gate:
   ```typescript
   const gate = config.agent?.requireSettledSessions ?? false;
   if (gate) {
     // Only pass settled session IDs to downstream query surfaces
   }
   ```

2. Pass only settled-session IDs to downstream tools. Do NOT call any read surface (FTS, semantic search, spore queries) with an unfiltered session scope when the gate is enabled.

3. Document the gate behavior in the task's YAML definition under `description` so operators know the task is gate-aware.

4. Test with `requireSettledSessions: true` and an active session present — confirm the task skips or gates that session's data correctly.

**Gotcha**: Tasks copied from an older template may call `vault_search_fts` or `vault_search_semantic` directly without the session-scope filter. If those surfaces were not yet gated when the template was written, the gate is bypassed. Always cross-check Procedure 3's surface list when authoring a new task.

## Cross-Cutting Gotchas

**Reactivation is a co-invariant of gating.** If `SessionStart` on a completed session does not flip status back to `active`, the gate silently loses live data. Test reactivation alongside any gate change. An easy regression check:
```bash
# Confirm the SessionStart handler updates status unconditionally
grep -A 10 "SessionStart" src/daemon/hooks/*.ts | grep "status.*active"
```

**`settledSessionIdleMinutes` too low causes false positives.** A developer pausing for 25 minutes can cause premature completion followed by immediate reactivation. The 30-minute default is conservative; tune only with real usage data and expect minor churn.

**Dismissal reason semantics for skill candidates.** When dismissing a skill candidate during the skill-survey task:
- `dismissal_reason: 'reject'` — permanently blocks this topic from future survey suggestions
- `dismissal_reason: 'stale'` — marks the candidate as outdated but keeps the category eligible for re-survey

These must not be conflated. Using `reject` when `stale` is correct silently closes off valid future skill suggestions for an entire topic area.
