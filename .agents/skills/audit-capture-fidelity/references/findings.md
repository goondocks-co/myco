# Finding Reference

One entry per finding id. Each gives: what it means, candidate root causes, **the observation that discriminates between them**, the fix pattern, and the gate that closes it.

The discriminating observation is the part that matters. Candidates usually look identical in the database, and guessing between them is how the wrong thing gets "fixed".

---

## `batch-null-content-hash`

**Means** — `prompt_batches.content_hash` is NULL. That column is the dedup key, so these rows cannot be matched against an incoming prompt and reconciliation can insert a duplicate of the same turn.

**Candidates**
1. A writer path that inserts batches without computing the hash.
2. Rows predating the hash being introduced or made mandatory.

**Discriminate** — the ACTIVE/LEGACY split does it. LEGACY with a cutoff date means (2), a bounded backlog. ACTIVE means (1) and there is a live writer to find: grep for direct `INSERT INTO prompt_batches` that bypasses the shared writer.

**Fix** — (1) route the writer through the shared insert helper. (2) backfill only; there is no code fix to make.

**Gate** — a test asserting every insert path populates `content_hash`; for the backfill, a check that the column is NOT NULL for rows newer than the cutoff.

---

## `batch-missing-response`

**Means** — a non-active batch whose `response_summary` is empty. The user's prompt was captured; the assistant's reply was not.

**Candidates**
1. The Stop hook never fired (the fragile point — see `stop-hook-fragility`).
2. The hook fired but the daemon was down and the buffer never converged.
3. Transcript mining never ran for the session, or ran before the reply was flushed.
4. The agent genuinely produced no response (interrupted turn).

**Discriminate** — check `sessions.final_mine_ok` for the owning session, then look for the session's buffer file. `final_mine_ok = 0` points at (3). A buffer file still on disk points at (2). Neither, with the hook installed, points at (1). Cross-check one transcript by hand: if the reply is absent from the transcript too, it is (4) and not a defect.

**Fix** — (1) repair hook wiring; (2) buffer convergence; (3) re-mine the session; (4) nothing.

**Gate** — for (1)/(2), a test in `tests/capture/`. Note that re-mining repairs data without preventing recurrence — it is not a gate.

---

## `batch-zero-activities`

**Means** — a completed batch that recorded no tool activity.

**Candidates**
1. A pure-conversation turn. Legitimate and common.
2. Tool events were dropped for that turn.

**Discriminate** — look at the distribution, never a single row. If the rate is comparable across symbionts it is (1). If it clusters on one agent, that agent's PreToolUse/PostToolUse contract has probably drifted — compare its hook template against what the agent currently emits.

**Fix** — (2) correct the tool hook field paths in the manifest.

**Gate** — a manifest gate asserting the agent declares tool hook fields, plus a parser test over a real transcript containing tool calls.

---

## `session-counter-drift`

**Means** — `sessions.prompt_count` disagrees with the actual number of `prompt_batches`.

**Candidates**
1. A writer inserted batches without updating the denormalised counter.
2. Batches were deleted without decrementing.

**Discriminate** — sign of the difference. Counter lower than reality is (1); higher is (2).

**Fix** — recompute the counter, and route the offending writer through the shared path. **The counter is what is wrong here, not the data** — never delete batches to make a counter agree.

**Gate** — a test asserting the counter after an insert through each writer path.

---

## `batch-orphaned`

**Means** — a batch whose `session_id` does not resolve. The FK should make this impossible.

**Candidates**
1. Rows written while FK enforcement was off.
2. A session deleted without cascading.

**Discriminate** — check `session_tombstones` for the missing id. A tombstone means (2) and the cascade is incomplete; no tombstone means (1).

**Fix** — high severity, and **do not delete the orphans** — they hold captured user work. Re-parent to the correct session where recoverable; otherwise escalate. Deleting is explicitly forbidden.

**Gate** — a test asserting `PRAGMA foreign_keys` is on for every connection that writes.

---

## `closure-exit-hook-missed`

**Means** — sessions past the stale threshold for an agent that registers a SessionEnd hook, so they should have closed at exit.

**Candidates**
1. The exit hook is not installed for this agent.
2. It is installed but failed silently.
3. The process was killed and never got to run it.

**Discriminate** — check the agent's installed hook config for a SessionEnd entry; then the daemon log for the hook's arrival. Installed and never arriving is (2); arriving with an error is also (2); (3) leaves no trace at all and is expected occasionally — judge by rate, not by a single session.

**Fix** — (1) reinstall via the installer; (2) see `stop-hook-fragility`.

**Gate** — a template gate asserting the agent's `hooks.json` declares a session-end event. `hookClosingSymbionts()` already derives this set from the templates, so a rename breaks the gate loudly.

---

## `closure-sweep-missed`

**Means** — the session-maintenance sweep ran after these passed the threshold and left them open. **The defect is in the sweep, not the schedule.**

**Candidates**
1. The sweep skipped them (unconverged buffer, a guard holding them open).
2. The threshold used at runtime differs from the configured one.

**Discriminate** — check `hasUnconvergedBuffer` for the sessions and the effective `daemon.stale_session_threshold_ms` in live config for that Grove.

**Fix** — in `daemon/jobs/session-maintenance.ts`.

**Gate** — a unit test over the sweep with a session in the relevant state.

---

## `closure-sweep-not-running`

**Means** — sessions past the threshold, and no sweep has run since. **A different root cause from the above, with identical rows.**

`SESSION_MAINTENANCE` is a PowerManager job registered `runIn: ['active','idle','sleep']` (`daemon/power-jobs.ts`). It fires on power-state transitions, not on a wall clock — a machine that never changes state never runs it.

**Candidates**
1. The daemon is not running, or not serving this Grove.
2. The daemon is running but no power-state transition has occurred.
3. The job threw and stopped being scheduled.

**Discriminate** — daemon liveness first, then the daemon log for the last `SESSION_MAINTENANCE` entry, then any error at that timestamp. **Investigate job scheduling, not session code.**

**Fix** — depends on the candidate; (2) may be a design gap worth a plan rather than a patch, since a long-lived desktop can legitimately sit in one power state for days.

**Gate** — this is the one finding whose gate is usually *observability*: emit the last-run timestamp so the audit can read it directly instead of being handed it.

---

## `transcript-never-captured`

**Means** — a transcript on disk, attributable to a project this Grove tracks, with no session row anywhere. Capture never ran for it. This is whole-session loss and the highest-value finding the audit produces.

The audit has **already excluded** the by-design cases: plugin-reported agents, sub-agent threads reattributed to a parent, and manifest-dropped classes. What is left is genuinely missing.

**Candidates**
1. Hooks were not installed for that agent when the session ran.
2. Hooks were installed but the daemon was not running or not serving the Grove.
3. Another daemon held the `symbiont-config` claim and routed capture elsewhere — a dev daemon can hijack capture machine-wide.
4. The session predates Myco being installed for that project.

**Discriminate** — the transcripts' timestamps first: a contiguous block bounded by dates points at (2) or (3), a scatter points at (1), everything before a start date is (4). Then check which `MYCO_HOME` currently holds the `symbiont-config` claim.

**Fix** — reinstall hooks; correct the claim. Historical sessions can be back-filled by mining the transcripts, which is why the files being on disk matters — this is an ingestion gap, not permanent loss.

**Gate** — `myco doctor` coverage for hook installation per agent, plus the claim check.

---

## `envelope-classified-human`

**Means** — prompts whose entire text is a single XML envelope are stored with `origin='human'`. An enclosing envelope is runtime-synthesized; a person did not type it. **This is the rot detector** — the `<teammate-message ` → `<agent-message from=` failure exactly.

Reported per (agent, tag), because each tag is its own gap with its own history. Rolling them together takes the newest date for all of them and reports a closed gap as active.

**Candidates**
1. The tag has no classify rule and the fail-safe (`prompt_is_enclosing_envelope`) did not catch it either — usually because the stored prompt is not a *single* balanced envelope, e.g. an envelope concatenated with other text.
2. A rule exists but its literal was renamed upstream.
3. The rows predate a fix that has already landed.

**Discriminate** — recency first: LEGACY with a cutoff is (3), and the fix is holding. For ACTIVE, pull the full `user_prompt` and check whether it is *entirely* one balanced envelope. If it is not, look at what else is in the prompt — that is (1), and the real cause is usually a different rule that stopped matching because the runtime prepended something.

Worked example: a codex prompt opened with `<recommended_plugins>` and continued into `# AGENTS.md instructions…`. The AGENTS.md drop rule keyed on `prompt_starts_with`, the marker was no longer at position 0, and 55 context injections were captured as prompts in one day. The envelope finding was the *symptom*; the broken rule was the cause.

**Fix** — re-key the rule on a structural signal, or on `prompt_contains` when the marker can move within the text. **Swapping one literal for another just resets the same clock.**

**Gate** — a rule test covering both the old and new shapes, as in `tests/capture/codex-agents-md-injection.test.ts`.

---

## `envelope-prefixed-prompt-classified-human`

**Means** — a prompt that opens with a *closed* envelope and then continues into other content, stored as `origin='human'`. The whole-prompt fail-safe does not cover this shape, so nothing catches it generically.

The closing tag is the discriminator: a runtime prefixing a complete envelope onto content it already injected produces `<tag>…</tag>rest`, whereas a person opening a message with markup (`<div> renders wrong`) never closes it. Unclosed leading tags are treated as prose and not reported.

**Candidates**
1. A runtime began prefixing an envelope onto an existing injection, displacing the marker that a `prompt_starts_with` rule matched. The rule is intact and matches nothing.
2. The content after the envelope is genuinely a person's, pasted after machine output.

**Discriminate** — read one row in full. If the text after the envelope is machine-generated, it is (1); find the rule that should have matched that text and check whether it is anchored to the start of the prompt.

Worked example: a codex prompt opened `<recommended_plugins>…</recommended_plugins>` and continued into `# AGENTS.md instructions…`. The AGENTS.md drop rule keyed on `prompt_starts_with`, so it stopped firing and 55 injections were captured as prompts in one day.

**Fix** — re-key so a prefix cannot displace the marker. **Widening to a bare `prompt_contains` while the action is still `drop` is not safe**: a substring match would discard any real prompt quoting the marker, and a drop is unrecoverable. Pair the marker with the envelope, or switch the action to `classify`.

**Gate** — a rule test covering the prefixed and unprefixed shapes, plus a human prompt that quotes the marker.

---

**Why not rule-replay** — an earlier version of this check replayed each declared rule over transcripts and reported the ones that never fired. It was abandoned: envelope rules fire on raw entries during mining, and the parser has already removed the envelopes by the time it produces turns, so every envelope rule looked dead. Measured: `<system-reminder>` appeared raw in 6 of 40 transcripts and in 0 parsed turns. Checking the stored outcome needs no replay and no knowledge of any specific tag.
