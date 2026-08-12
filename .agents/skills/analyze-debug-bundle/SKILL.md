---
name: myco:analyze-debug-bundle
description: >
  Use this skill when a bug report or issue has a `myco-diagnostic-*.zip` attached, or when
  asked to "analyze this diagnostic bundle", "analyze this debug bundle", "look at this bundle
  from an issue", or otherwise investigate a Myco diagnostic export without access to the
  reporter's live machine. Walks the bundle top-down in a fixed order — manifest sanity,
  doctor/audit findings, per-session transcript↔vault correlation, buffer/quarantine evidence,
  then log correlation — and produces a verdict naming the first layer where evidence diverges.
  Complements `debug-capture`, which investigates a live machine; this skill investigates a
  frozen snapshot someone else exported.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob, Write
---

# Analyze Debug Bundle

Top-down procedure for reading a `myco-diagnostic-*.zip` attached to a bug report and turning it
into a verdict: which layer diverged, what the evidence is, and what to do next. This is the
bundle-shaped sibling of `debug-capture` — same "walk the layers in order, stop at the first
divergence" discipline, but over a static export instead of a live daemon.

## Why this exists

A diagnostic bundle is built once, by someone else's machine, and handed to you cold — no shell
on their box, no live daemon log to tail, no ability to re-run a check. Everything you can know is
in the zip. The bundle is deliberately privacy-shaped (default export contains zero prompts, zero
code, zero prose — only structure, counts, and hashes), which means the naive read of any single
file usually looks empty or inconclusive. The signal is in *correlation across files*: whether
counts, ordinals, and hashes line up between layers. This skill is the order to check them in and
the one hash pair that's actually comparable across layers (most aren't — see Step 3).

## Bundle format (restated from source — the code is the source of truth)

Built by `buildDiagnosticBundle` in `packages/myco/src/capture/diagnostics/index.ts`. A per-layer
try/catch means one broken collector never blocks the rest — a missing file is either an honest
absence (noted) or a recorded collector error, never silent.

### `manifest.json`

```jsonc
{
  "bundle_format": 1,
  "myco_version": "1.4.4",
  "schema_version": 88,                // compare to this repo's SCHEMA_VERSION
  "platform": "darwin-arm64",
  "grove_id": "...",
  "window": { "since": 1234567890, "until": 1234571490 },  // epoch seconds, inclusive
  "include_content": false,             // whether prose/prompt text was included (private re-export only)
  "generated_at": 1234571500,
  "doctor_vault_dir": "...",            // the BOOTSTRAP vault dir doctor.json ran against
  "files": ["manifest.json", "environment.json", ...],  // must equal the zip's actual inventory
  "collector_errors": [{ "layer": "audit", "error": "..." }],
  "notes": ["session sA: no surviving buffer (converged buffers are deleted after drain)", ...]
}
```

**Read `collector_errors` and `notes` FIRST, before opening any other file.** They tell you what's
missing and why *before* you go looking for it and mistake absence for evidence. A `collector_errors`
entry means that layer's file plain doesn't exist in the zip — don't chase a phantom "why is
`audit-report.json` empty," it's absent because the layer threw. A `notes` entry like
`"session sA: no surviving buffer"` is explicitly **not** a red flag by itself — see Step 4.

Also check up front:
- **`bundle_format`** — this skill (and any tooling) targets format `1`. A newer format may have
  restructured files; don't assume the shapes below still apply without checking the collector
  source for that format.
- **`myco_version` / `schema_version` vs current** — a large gap is itself often the whole story
  (a bug already fixed in a newer release, or a schema migration mid-window).
- **`include_content`** — almost always `false` for a bundle attached to a public issue. If `true`,
  the reporter did a private re-export with prose intact; treat that content as sensitive and don't
  paste it into a public issue thread.

### `environment.json`, `doctor.json`, `audit-report.json`

- **`environment.json`** — `{ myco_version, schema_version, platform, os_release, node_version, pid, uptime_seconds, config }`. `config` is the redacted merged config (any key matching `/key|token|secret|password|credential|bearer/i` is `"[redacted]"`).
- **`doctor.json`** — the same array `myco doctor` prints: `DoctorCheck[]`, each `{ name, status: 'ok'|'fail'|'warn', detail, fixable }`. Scan for `status !== 'ok'` first — the `detail` string is written to be read by a human and often names the anomaly outright ("No sessions in the last N days...", "Database error: ...").
- **`audit-report.json`** — output of `runAudit` (`packages/myco/src/capture/audit/index.ts`): `{ dbPath, projectId?, since?, generatedAt, symbionts: SymbiontContext[], findings: Finding[], coverage: CoverageGap[] }`. Each `Finding` is `{ id, layer: 'drift'|'pipeline'|'integrity', severity: 'high'|'medium'|'low', title, count, recency: 'active'|'legacy'|'unknown', firstSeen?, lastSeen?, symbiont?, samples: string[], detail }`. `layer: 'drift'` means the agent's transcript format changed and Myco's parser/manifest hasn't caught up; `layer: 'pipeline'` means the parse was fine but the row never landed — different bugs, different fixes. `coverage` entries are honest "we didn't check this" gaps — treat a symbiont/scope listed there as unaudited, not clean.

### `sessions.jsonl` and `agent-runs.jsonl`

Both are JSONL where every line is `{ "table": "<name>", "row": {...} }`, multiple tables interleaved in one file:

- **`sessions.jsonl`** carries `sessions`, `prompt_batches`, `session_tombstones` rows.
  - `sessions` row: structural columns verbatim (`id, agent, user, project_root, project_id, branch, started_at, ended_at, status, prompt_count, tool_count, transcript_path, parent_session_id, parent_session_reason, content_hash, machine_id, ...` plus Canopy injection counters) + `title`/`summary` replaced by `title_sha256`/`title_bytes` and `summary_sha256`/`summary_bytes` unless `include_content` is true.
  - `prompt_batches` row: structural columns (`id, project_id, session_id, parent_prompt_batch_id, kind, origin, prompt_number, classification, started_at, ended_at, status, activity_count, processed, content_hash, thread_id, thread_label, ...`) + `response_summary_sha256`/`response_summary_bytes`, and — separately — **`user_prompt_sha256`**: sha256 of the prompt text **trimmed**, with no accompanying `_bytes` field. This asymmetry is deliberate; see Step 3.
  - `session_tombstones` row: `session_id, project_id, deleted_at, source`. `source: 'phantom_reap'` = working as intended (injection-only phantom session cleaned up), not capture loss.
- **`agent-runs.jsonl`** carries `agent_runs`, `agent_reports`, `agent_turns` rows (Myco's own agent-pipeline audit trail, not the reporter's coding-agent transcripts). Prose columns (`instruction`, `checkpoints`, `actions_taken`, `error`, `run_context` on runs; `summary`, `details` on reports; `tool_input`, `tool_output_summary` on turns) each become `<col>_sha256`/`<col>_bytes` pairs unless `include_content` is true.

### `transcripts/<sessionId>.skeleton.jsonl` (+ `.full.jsonl` when `include_content: true`)

One skeleton file per session in the window, sourced from the *reporter's coding-agent transcript*
(Claude Code, Codex, etc. — not Myco's own agent runs). Each line is a structure-only projection of
one raw transcript event, built from a fixed field set so unknown/evolving transcript fields can
never leak prose:

```jsonc
{
  "type": "user",              // or 'unknown' if absent/fails the identifier pattern
  "timestamp": "2026-08-12T...",  // or null
  "uuid": "...",                // or null
  "parent_uuid": "...",         // or null — the transcript's own parent-chain link
  "role": "user",               // message.role, or null
  "content_hash": "sha256(JSON.stringify(message.content))",  // or null if no content field at all
  "text_sha256": "sha256(trimmed user-visible text)",          // or null if no extractable text
  "byte_length": 1234           // raw line length in bytes
}
```

A line that fails to JSON-parse becomes `{ "type": "unparseable", "byte_length": N }` — that's a
transcript corruption/truncation signal on its own.

**`content_hash` is NOT `text_sha256`.** `content_hash` hashes the entire raw `message.content`
value (which may be a content-block array with tool_use/tool_result/image blocks, not just text);
`text_sha256` hashes only the extracted, trimmed, user-visible text. Two lines can have different
`content_hash` (different tool-call payloads) but the same `text_sha256` (same visible words) —
that's normal, not a discrepancy.

### `buffers/<projectId>/<sessionId>.jsonl` (+ `buffers/<projectId>/quarantine/<sessionId>.jsonl`)

Skeletonized raw capture-event lines (the daemon's own on-disk durability buffer, one line per
hook event), same allowlist-projection principle as transcripts:

```jsonc
{ "event_type": "user_prompt", "timestamp": "...", "session_id": "sA", "byte_length": 512, "content_hash": "sha256(raw line)" }
```

Like transcript skeletons, buffer skeleton lines are **flat** — no `table`/`row` wrapper. Only
**live** buffers for sessions inside the window are included; **all** quarantine-dir buffers are
included regardless of window. Two separate clocks govern quarantine, not one: a diverging buffer
moves INTO `quarantine/` once it's `BUFFER_HARD_RETENTION_MS` = 7 days old; the quarantined file is
then pruned (deleted) once it's `TOMBSTONE_RETENTION_MS` = 14 days old
(`packages/myco/src/constants.ts:123,134`; the move-then-prune sequence runs in `cleanBufferDirs`,
`packages/myco/src/daemon/reconciliation.ts:1209-1245`). So a quarantined file you see in a bundle
has been sitting there for a while, not freshly diverged — don't read "quarantine entry" as "this
diverged just now."
`content_hash` here is a hash of the raw JSONL line, not a cross-layer key — don't compare it to
`text_sha256` or `user_prompt_sha256`. `event_type` is read from the raw capture event's `type`
field (values like `user_prompt`, `tool_use`, `stop_failure` — see `daemon/event-dispatch.ts`'s
`EventBody` schema), with `event_type` accepted as a fallback for any line that carries that name
instead; a line where neither field is present reads `"unknown"`.

### `log-entries.jsonl` and `daemon-log.jsonl`

Both JSONL, both windowed, but scoped differently:

- **`log-entries.jsonl`** — the Grove-scoped `log_entries` table (per-Grove structured event log). Row: `id, project_id, timestamp, level, component, kind, message, session_id` plus either the original `data` field (if `include_content`) or a `payload` object where `data`'s parsed keys are individually hashed: `{ "<key>": { "byte_length": N, "sha256": "..." } }` (or `{ "_unparseable": {...} }` if `data` wasn't valid JSON).
- **`daemon-log.jsonl`** — a machine-global slice of the daemon's own log file, one line per entry as `{ "table": "daemon_log", "row": {...} }`. Row keeps `timestamp, level, kind, component, message, session_id, project_id` verbatim (opaque structural ids, not prose — this is the deliberate join key) and folds every other field (`prompt_preview`, etc.) into a `payload` object hashed the same way as `log-entries.jsonl`. **`daemon-log.jsonl` NEVER honors `include_content`** — even a private re-export ships this file redacted, because one daemon serves every Grove on the machine and the exporting user has no standing to disclose another Grove's data. If you need daemon-log prose, it has to come from the live machine (see Cross-reference below).

## Procedure (walk in this exact order)

### Step 1 — Unzip and manifest sanity

```bash
mkdir -p /tmp/bundle-analysis && cd /tmp/bundle-analysis   # or your scratchpad
unzip -o /path/to/myco-diagnostic-*.zip -d .
jq . manifest.json
jq '.bundle_format, .myco_version, .schema_version, .include_content' manifest.json
jq '.collector_errors' manifest.json
jq '.notes' manifest.json
```

Confirm `bundle_format` is a format this skill covers, note the version/schema gap vs. current
`main`, and **read every `collector_errors` and `notes` entry before opening anything else** —
they tell you what to expect to be missing and why. `Write` is granted only for this kind of
scratchpad use: saving the unzipped extraction, any one-off correlation script, and the final
verdict write-up to the scratchpad — never for writing back into bundle files or the repo itself.

### Step 2 — `doctor.json` and `audit-report.json`

```bash
jq '.[] | select(.status != "ok")' doctor.json
jq '.findings[] | select(.severity != "low")' audit-report.json
jq '.coverage' audit-report.json
```

These often name the anomaly outright — a `doctor.json` `fail`/`warn` `detail` string or an
`audit-report.json` finding's `title`/`detail` may already describe exactly the bug being
reported. Don't skip straight to transcript correlation; check whether the tool already found it.
Note `layer: 'drift'` vs `'pipeline'` findings separately — they point at different code.

### Step 3 — Per-session correlation: transcripts ↔ sessions.jsonl

For each session id present in `transcripts/*.skeleton.jsonl` and/or `sessions.jsonl`, compare:

1. **Event/batch counts** — number of skeleton lines with `role: "user"` vs. number of
   `prompt_batches` rows for that `session_id` (`jq 'select(.table=="prompt_batches" and .row.session_id=="<sid>")' sessions.jsonl`). Note the shape difference: skeleton lines in `transcripts/*.skeleton.jsonl` are **flat** objects (`.role`, `.text_sha256`, ...) with no `table`/`row` wrapper, while every other JSONL file in the bundle (`sessions.jsonl`, `agent-runs.jsonl`, `log-entries.jsonl`, `daemon-log.jsonl`) wraps each row as `{ "table": "...", "row": {...} }`. Mixing the two access patterns up is the most common jq mistake against this bundle.
2. **Ordinals / ordering** — do batch `prompt_number` values and skeleton line order agree?
3. **Timestamps** — do `started_at`/`ended_at` on the `sessions` row bracket the skeleton's
   `timestamp` range?
4. **The shared hash** — skeleton `text_sha256` for `role: "user"` lines vs. `prompt_batches`
   row's `user_prompt_sha256`. This is **the only hash pair that is directly comparable across
   the transcript and vault layers** — both are `sha256(text.trim())` of the same underlying
   prompt text (`skeletonize.ts` and `collect-vault.ts`'s `projectBatchRow` compute them
   identically). Extract and diff the two sequences:

   ```bash
   jq -r 'select(.role=="user") | .text_sha256' transcripts/<sid>.skeleton.jsonl
   jq -r 'select(.table=="prompt_batches" and .row.session_id=="<sid>") | .row.user_prompt_sha256' sessions.jsonl
   ```

   **Do not compare either of these to `content_hash` on the skeleton, or to `content_hash` on the
   `sessions`/`prompt_batches` rows.** The stored `content_hash` columns on `sessions` and
   `prompt_batches` are *canonical-tuple* hashes — `sha256(session_id + " " + origin + " " + ordinal + " " + normalized_prompt [+ thread_id])`, per `promptBatchContentHash` in `packages/myco/src/db/queries/batches.ts:126-175` — a dedup key over a composite tuple, not a hash of prompt text alone. They will **never** match `text_sha256` or `user_prompt_sha256` even when capture is perfectly correct. Chasing that mismatch as "divergence" is a dead end — say so explicitly if you rule it out, so the next reader doesn't re-walk it.

The **first layer where counts or hashes diverge** (skeleton has more user turns than
`prompt_batches` has rows, or a `text_sha256` present in the skeleton has no matching
`user_prompt_sha256` in `sessions.jsonl`, or vice versa) is the suspect layer — stop climbing
layers past that point until you've explained the divergence found here.

### Step 4 — Buffers and quarantine

```bash
ls buffers/*/                      # live, in-window buffers
ls buffers/*/quarantine/ 2>/dev/null   # ALL quarantined buffers, any window
```

A **quarantined** buffer (`buffers/<projectId>/quarantine/<sessionId>.jsonl`) is direct evidence
of a diverging-capture event — the daemon quarantines a buffer specifically when live capture and
the durability buffer disagree. Read it; the skeletonized lines' `event_type`/`timestamp` sequence
shows what was captured right before quarantine triggered.

An **absent** live buffer for a session in the window is *not* evidence of anything by itself —
converged buffers are deleted after a successful drain, and a `notes` entry
(`"session <sid>: no surviving buffer (converged buffers are deleted after drain)"`) already told
you this in Step 1. Only treat buffer absence as a lead if Step 3 already found a divergence for
that session and you're looking for corroborating detail on *when* it happened.

### Step 5 — Log correlation: `log-entries.jsonl` then `daemon-log.jsonl`

Check Grove-scoped logs first, then the machine-global slice, correlating both to the session(s)
under investigation by the verbatim `session_id` (and `project_id`) join key — neither file hashes
these fields, by design, so they're safe to grep/filter directly:

```bash
jq 'select(.row.session_id=="<sid>")' log-entries.jsonl
jq 'select(.row.session_id=="<sid>")' daemon-log.jsonl
```

Walk both across the **full bundle window**, not just around the suspected divergence point —
the event that explains a Step 3 divergence (a duplicate hook fire, a dedup-window suppression, a
crash/restart) is often several seconds to minutes before or after the divergent prompt itself.
`daemon-log.jsonl`'s `kind`/`component`/`message` fields are always plain, code-authored strings
(never templated with user content), so `message` values like `"Event suppressed as duplicate
within dedup window"` or `"Failed to open batch"` are safe to grep for verbatim and often name the
mechanism directly — see `debug-capture`'s Step 3 for the fuller catalog of these log strings.

## Verdict template

Write findings in this shape — it's what makes a bundle-based investigation reproducible by
someone who doesn't have the bundle open:

```markdown
**Layer of divergence:** <e.g. "transcript ↔ prompt_batches, session sA">

**Evidence:**
- `transcripts/sA.skeleton.jsonl` line 7: `text_sha256=<hash>`, `role=user`, `timestamp=...`
- `sessions.jsonl`: no `prompt_batches` row for session `sA` carries `user_prompt_sha256=<hash>`
- `daemon-log.jsonl`: no `hooks.prompt` entry for `session_id=sA` in the 30s around that timestamp

**Suspected mechanism:** <e.g. "hook never fired for this turn — daemon-log shows no dispatch
entry at all, consistent with a client-side hook crash rather than a server-side drop">

**Suggested follow-up:**
- Repro steps to hand back to the reporter (what to do, what to watch for), OR
- If hashes alone can't distinguish two candidate mechanisms, ask for a **private** re-export
  with "Include full transcript content" enabled (sets `include_content: true`) scoped to a
  narrow window — this reveals prose in `transcripts/*.full.jsonl`, `sessions.jsonl`, and
  `agent-runs.jsonl`/`log-entries.jsonl`, but **never** `daemon-log.jsonl` (machine-global,
  always redacted regardless of the flag).
```

Name the layer, don't just describe symptoms — "session went silent" is a symptom; "no
`prompt_batches` row exists for a skeleton-confirmed user turn" is a layer.

## Worked example: duplicate-session divergence

Two session ids (`sA`, `sB`) both appear in the bundle with overlapping `started_at`/`ended_at`
windows (`sessions.jsonl`) — the reporter suspects "my session got recorded twice."

1. Pull both sessions' skeleton `uuid`/`parent_uuid` chains (flat objects, no `row` wrapper):
   ```bash
   jq -r 'select(.type!="unparseable") | (.uuid // "?") + " <- " + (.parent_uuid // "root")' transcripts/sA.skeleton.jsonl
   jq -r 'select(.type!="unparseable") | (.uuid // "?") + " <- " + (.parent_uuid // "root")' transcripts/sB.skeleton.jsonl
   ```
2. Pull both sessions' `text_sha256` sequences in order.
3. **Compare the two chains:**
   - **Identical `uuid` chain and identical `text_sha256` sequence** → this is *one* underlying
     harness session that got captured twice — a registry/dedup-layer bug (the same transcript
     was picked up by two independent capture paths, or a session id got reissued). Verdict layer:
     registry/session-identity, not the transcript or the agent.
   - **Disjoint `uuid` chains (different `parent_uuid` roots, non-overlapping `text_sha256`
     sequences)** → these are genuinely two separate sessions that happen to overlap in time — the
     harness was spawned twice (two terminal tabs, a retry after a crash, a sub-agent that got a
     top-level session instead of a thread). Confirm by checking `agent-runs.jsonl` for two
     `agent_runs` rows in the window, and `daemon-log.jsonl` for two separate
     `hooks.session_start`-shaped entries with different `session_id`s close together in time.

Either read is falsifiable from bundle contents alone — you should not need to guess.

## When the bundle isn't enough

If the divergence can't be resolved from hashes/counts alone (e.g. you need to see whether two
`text_sha256` values that don't match are near-duplicates due to whitespace/formatting, or you
need daemon-log prose that's redacted in every bundle regardless of `include_content`), the two
options are:

1. Ask the reporter for a **private re-export** with "Include full transcript content" checked,
   scoped to the narrowest window that covers the suspect session(s) — see the verdict template.
2. If the reporter can grant you access, or the bug reproduces locally, use `debug-capture` for a
   live-machine investigation — it walks the same capture lifecycle top-down but against a live
   daemon log, buffer directory, and Grove DB instead of a frozen export, so it can go further than
   any bundle ever will (live `daemon.log` tailing, process trees, retrying the repro).

## Related

- `.agents/skills/debug-capture/SKILL.md` — the live-machine counterpart; same "walk the layers,
  stop at first divergence" discipline, different evidence source.
- `packages/myco/src/capture/diagnostics/index.ts` — the bundle builder (`buildDiagnosticBundle`), layer list, manifest shape.
- `packages/myco/src/capture/diagnostics/collect-vault.ts` — `sessions.jsonl`/`agent-runs.jsonl` row projections, the `user_prompt_sha256` cross-layer key.
- `packages/myco/src/capture/diagnostics/skeletonize.ts` — transcript skeleton line shape, `text_sha256`.
- `packages/myco/src/capture/diagnostics/collect-buffers.ts` — buffer/quarantine layout and skeleton shape.
- `packages/myco/src/db/queries/batches.ts:126-175` — `promptBatchContentHash`, the canonical-tuple hash that is NOT comparable to `text_sha256`/`user_prompt_sha256`.
- `packages/myco/src/capture/audit/types.ts` — `Finding`/`CoverageGap` shapes in `audit-report.json`.
