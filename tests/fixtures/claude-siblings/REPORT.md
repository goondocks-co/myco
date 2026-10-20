# Fixture report: Claude Code user-record shapes

## What was searched
- 1540 JSONL transcript files under the Claude Code projects folder (main session files plus `subagents/agent-*.jsonl` files), read-only.
- Every line containing `"type":"user"` was parsed; assistant lines were only read to fetch the first assistant record after a sidechain line.
- Candidate selection ran from two scans; per-file "earlier record with the same promptId" was computed per file, in file order.

## A. Subagent (sidechain) user records with a promptId and text content
- Found: 1673 records (`type:user`, `isSidechain:true`, `promptId` present, not a tool_result).
- Of those, 911 are the subagent's initial prompt (`parentUuid:null`, not `isMeta`, string content). All 911 live in `subagents/agent-*.jsonl` files.
- The lead session's own prompt record with the same promptId is NOT in the same file as the sidechain line. It is in the parent session file (`<sessionId>.jsonl`, one directory up from `subagents/`) in 911 of 911 cases. This is a cross-file match.
- The remaining 762 are later sidechain records (isMeta/system-reminder/coordinator/peer/task-notification origin, text blocks); they are sibling shapes under C.
- Versions seen on A records: 2.1.149, 2.1.197, 2.1.205, 2.1.209, 2.1.219, 2.1.260, 2.1.278, 2.1.281, 2.1.282, 2.1.283, 2.1.284, 2.1.285, 2.1.293, 2.1.294, 2.1.295, 2.1.296, 2.1.300, 2.1.301, 2.1.302.
- `sidechain.jsonl` holds 4 groups (one per distinct key set of the initial prompt), each as lead record, sidechain prompt, first assistant record after it:

| Lines | Version | Count of this key set (initial prompts) | Notes |
|---|---|---|---|
| 1-3 | 2.1.205 | 628 | sidechain prompt extra keys: none |
| 4-6 | 2.1.284 | 270 | sidechain prompt extra keys: ['slug'] |
| 7-9 | 2.1.296 | 10 | sidechain prompt extra keys: ['sessionKind'] |
| 10-12 | 2.1.296 | 3 | sidechain prompt extra keys: ['sessionKind', 'slug'] |

Within each group: record 1 is the lead's prompt (isSidechain false; groups 1 and 3 are `origin.kind:human`, groups 2 and 4 are `origin.kind:task-notification`, i.e. the promptId shared with a subagent can belong to a task-notification turn, not a person's prompt), record 2 is the sidechain prompt (`parentUuid:null`, has `agentId`), record 3 is the first assistant record in the subagent file after it.

## B. Teammate / agent message records
- `<teammate-message ...>` as the first thing in a user record's text: 127 records (117 sidechain records carrying `agentId`; 10 non-sidechain records in lead files carrying `permissionMode`, no `origin`). Versions: 2.1.149 (122), 2.1.278 (5).
- `<agent-message` as a user-record envelope: 0 found. (The string appears only as a mention inside other free text.)
- Attributes seen on teammate-message: `teammate_id`, `color`, `summary` (combinations: teammate_id+color, teammate_id+summary, teammate_id only).
- `teammate.jsonl` holds 3 groups: lines 1-5 (v2.1.149, sidechain teammate message that is a sibling of an earlier record; includes the lead-file teammate message at line 1, two tool_result records, and a second sidechain teammate message at line 5), lines 6-7 (v2.1.278, lead human prompt then the sidechain-first teammate message with `parentUuid:null`), line 8 (v2.1.149, non-sidechain teammate message with `permissionMode`).

## Envelope tags at the start of a user record's text (every one seen, with promptId; counts from the full scan)
| Tag | Non-sidechain | Sidechain |
|---|---|---|
| task-notification | 2822 | 0 |
| pasted_content | 671 | 0 |
| teammate-message | 10 | 117 |
| system-reminder | 0 | 77 |
| command-name | 25 (+3 without promptId) | 0 |
| local-command-caveat | 24 (+3 without) | 0 |
| local-command-stdout | 23 (+3 without) | 0 |
| command-message | 10 | 0 |
| fork-boilerplate | 0 | 4 |
| project-instructions | 0 | 4 |

Inner tags seen inside task-notification: task-id, tool-use-id, output-file, status, summary, note, result, usage (subagent_tokens, tool_uses, duration_ms). Command envelope inner tags: command-name, command-message, command-args.
`origin.kind` values seen on user records: human, coordinator, task-notification, peer.

## C. Other user-record shapes sharing a promptId with an earlier user record in the same file
- 119859 sibling user records in total. 119038 are tool_result records (known; three shapes: lead tool_result with toolUseResult 51989, sidechain tool_result with toolUseResult 39108, sidechain tool_result without 27941). These are not in the fixture.
- About 816-821 are NOT tool_results (the second scan classified 816; 5 more are text+tool_result mixed `fork-boilerplate` records). Their sibling shapes (sidechain / isMeta / content kind / envelope / origin.kind), counts as sampled in the second scan:

| Count | Sidechain | isMeta | Content | Envelope | origin.kind |
|---|---|---|---|---|---|
| 144 | no | yes | text blocks | none | none |
| 97 | no | no | string | none | none |
| 94 | no | no | string | task-notification | task-notification |
| 91 | yes | no | string | teammate-message | none |
| 79 | yes | yes | string | none | none |
| 77 | yes | yes | string | system-reminder | none |
| 47 | yes | yes | string | none | coordinator |
| 31 | no | yes | string | none | none |
| 27 | no | no | text blocks | none | none |
| 24 | no | no | string | command-name | none |
| 23 | no | no | string | local-command-stdout | none |
| 19 | yes | yes | text blocks | none | none |
| 18 | yes | no | text blocks | none | none |
| 16 | yes | no | string | none | none |
| 12 | no | no | string | none | human |
| 8 | no | no | string | pasted_content | human |
| 6 | yes | yes | string | none | task-notification |
| 2 | yes | yes | string | none | peer |
| 1 | no | yes | string | none | peer |

The earlier (first) record for these promptIds is most often: a human prompt (`origin.kind:human`, string or image+text), a task-notification record, a command-name/local-command-caveat pair, a sidechain initial prompt, or a tool_result record. The most important unknowns: isMeta text-block siblings of a human prompt (144, injected content following the person's prompt), plain string siblings with no origin (97), and task-notification siblings (94) sharing the preceding turn's promptId.
- `unknown-siblings.jsonl` holds 86 pairs (earlier record, then the sibling; pair n is lines 2n-1 and 2n), 172 lines. Pairs are grouped by source transcript, not by frequency. They cover every distinct (earlier-shape, sibling-shape) combination plus one smallest example per distinct harness-constant signature (see "Harness constants"). Ids were remapped afresh and consistently within this file.

## Versions seen
- A: 2.1.149 to 2.1.302 (see list above). B: 2.1.149, 2.1.278. C: 2.1.149, 2.1.181, 2.1.197, 2.1.205, 2.1.209, 2.1.219, 2.1.260, 2.1.278 to 2.1.285, 2.1.289, 2.1.292 to 2.1.296, 2.1.299 to 2.1.303.

## Top-level key sets (user records)
Base keys on every user record: `parentUuid, isSidechain, promptId, type, message, uuid, timestamp, userType, entrypoint, cwd, sessionId, version, gitBranch`.
Optional keys seen: `agentId` (subagent files), `slug`, `sessionKind`, `isMeta`, `origin` (object, `kind` plus kind-specific fields such as `runId`), `permissionMode`, `promptSource`, `turnOrigin`, `queueSkipAttachments`, `turnCompanion`, `toolUseResult`, `sourceToolAssistantUUID`, `permissionDecision`, `session_id` (a second spelling beside `sessionId`), `isCompactSummary`, `isVisibleInTranscriptOnly`.
- Sidechain initial prompt: base + `agentId`, optionally `slug`, `sessionKind`.
- Lead human prompt in these groups: base + `origin, permissionMode, promptSource`, optionally `turnOrigin, sessionKind`.
- Lead task-notification turn: base + `origin, permissionMode, promptSource, queueSkipAttachments, turnOrigin`, optionally `slug, sessionKind`.
- Teammate-message in a lead file: base + `permissionMode`. In a subagent file: base + `agentId`.
- tool_result user record: base + `toolUseResult` (not always), `sourceToolAssistantUUID`, `agentId` in subagent files, sometimes `permissionDecision` and `session_id`.
- Assistant record (first after a sidechain prompt): base keys + `agentId, requestId, attributionAgent`, and in newer versions `advisorModel, apiBlockIndex, effort, perTurnEffort, wireToolInputs, requestedModel, thinkingDisplay, thinkingDurationMs, sessionKind, slug`.
Exact key sets for each fixture record are visible in the jsonl files.

## Redaction applied
- Every message text body replaced by `REDACTED`, keeping whitespace; only these envelope tags kept (names and attribute NAMES, attribute values set to `REDACTED`): teammate-message, agent-message, task-notification and its inner tags, system-reminder, pasted_content, command-name/message/args, local-command-*, fork-boilerplate, project-instructions. Any other angle-bracket text was treated as body text and replaced.
- Tool inputs, tool_result content, toolUseResult, thinking text and signatures, image data: replaced (all strings `REDACTED`, numbers 0, booleans kept, keys kept).
- `cwd` -> `REDACTED_CWD`; `gitBranch` -> `REDACTED_BRANCH`; `slug` -> `redacted-slug`; `origin` keeps only `kind`.
- `uuid, parentUuid, promptId, sessionId, session_id, requestId, agentId, sourceToolAssistantUUID, tool_use_id, tool_use ids, message.id` remapped consistently (one map across all three files) to fresh random ids of the same style (uuid4, `toolu_`, `msg_`, `req_` prefixes, hex for agent ids).
- Timestamps: format kept, each fixture group shifted so its earliest record is 2026-01-01T00:00:00.000Z; relative offsets preserved.
- Kept unchanged in unknown-siblings.jsonl (harness constants, see below): `promptSource`, `turnOrigin`, `origin.kind/producer/fromMode/name(general-purpose only)`, the two interrupt marker texts, built-in slash command names.
- Kept unchanged: field names and nesting, `type`, `version`, booleans, `userType`, `entrypoint`, `permissionMode`, `origin.kind`, `role`, `model`, `stop_reason`, tool names, usage-style numbers, content block types.
- Post-check: all three jsonl files and this report were grepped for the owner's username, home-directory prefixes, email markers, the owner's domains and organisation names, temp-folder paths and hosting URLs; no hits remained.

## Harness constants
All values below are fixed tokens Claude Code writes itself; they appear verbatim in `unknown-siblings.jsonl`. Counts are over all user records in the 1540 files.

### 1. `promptSource`, `turnOrigin`, `origin` sub-fields
| Field | Value | Count |
|---|---|---|
| promptSource | `system` | 2509 |
| promptSource | `typed` | 1385 |
| promptSource | `sdk` | 1070 |
| promptSource | `queued` | 52 |
| promptSource | `suggestion_accepted` | 33 |
| turnOrigin | `task_notification` | 2383 |
| turnOrigin | `human` | 1479 |
| turnOrigin | `sdk` | 342 |
| turnOrigin | `peer` | 88 |
| turnOrigin | `scheduled` | 38 |
| origin.kind | `task-notification` | 2943 |
| origin.kind | `human` | 1720 |
| origin.kind | `coordinator` | 328 |
| origin.kind | `peer` | 104 |
| origin.producer | `session-task` | 1963 |
| origin.fromMode | `bypass` | 1 |
| origin.handback | boolean `true` | 18 |

Other `origin` sub-fields (shape only, not constants): `runId` (string, 20 chars, 1296), `from` (string 12-30 chars, 104), `senderTaskId` (string, 19 chars, id-like, 103), `body` (string, user content, 102), `name` (string, 85: `general-purpose` 71, the rest are user-chosen task names; only `general-purpose` kept), `verifiedPeerPid` (integer, 1), `msg_id` (string, 1), `handbackReportText` (string, user content, 1). Redacted values: strings become `REDACTED`, integers 0.
`suggestion_accepted` (33) did not land in a fixture sibling pair; the other four promptSource values and all five turnOrigin values did.

### 2. Text-block user siblings (non-sidechain, non-meta, content is a list, promptId seen earlier)
| Text | Count |
|---|---|
| `[Request interrupted by user]` | 15 |
| `[Request interrupted by user for tool use]` | 12 |
No other text values occur in this class. (Other text-block siblings in this class carry pasted content with `pasted_content` envelopes, redacted.)

### 3. isMeta records carrying origin / promptSource / turnOrigin
| origin.kind | promptSource | turnOrigin | Count |
|---|---|---|---|
| coordinator | (absent) | (absent) | 328 |
| task-notification | (absent) | (absent) | 115 |
| peer | system | peer | 88 |
| (no origin) | system | scheduled | 38 |
| peer | sdk | (absent) | 13 |
| (no origin) | sdk | (absent) | 3 |
| peer | (absent) | (absent) | 3 |

### 4. `isVisibleInTranscriptOnly: true`
110 records. All are string-content records that also have `isCompactSummary: true` (compaction summaries; body is user-derived, redacted). By sibling state: 104 share a promptId with an earlier user record in the same file (88 main-thread, 16 sidechain), 6 do not (5 main-thread, 1 sidechain). `isMeta` is false on all.

### 5. `<command-name>` values
Built-in Claude Code commands (kept verbatim): `/model` 10, `/exit` 5, `/chrome` 5, `/login` 3, `/reload-plugins` 2, `/goal` 1, `/effort` 1, `/mcp` 1. (`/goal` is treated as built-in; it is the least certain classification.) Not seen: `/clear`, `/compact`.
Custom/skill commands (replaced by `REDACTED`): 10 occurrences across 2 distinct names (9 and 1).
`/login` did not land in a fixture sibling pair; the others did.

## Contiguous reuse
Question: how often do 2 or more distinct records (distinct uuid) that carry a marker (`origin` / `promptSource` / `turnOrigin`) and are not `isVisibleInTranscriptOnly` share one promptId within one file.

### Counts
- 11 cases across all 1540 files (a case is one promptId in one file). Case sizes: 9, 43, 43 records and eight cases of 2-3 records.
- Marker combinations (by `origin.kind` set):

| Combination | Cases | Notes |
|---|---|---|
| task-notification + human + peer | 1 | 43 records: 40 task-notification (`system`/`task_notification`), 2 human (`typed`/`human`), 1 peer (`system`/`peer`, isMeta) |
| task-notification + human | 2 | 9 records (6 human, 3 task-notification) and a 43-record fork of the case above (2 human, 41 task-notification; last record has `turnOrigin` absent) |
| task-notification + coordinator | 4 | sidechain, isMeta, no promptSource/turnOrigin |
| task-notification only | 2 | sidechain, isMeta |
| peer only | 1 | sidechain, isMeta |
| coordinator only | 1 | sidechain, isMeta |

- The 3-kind case (task-notification, human, peer under one promptId) exists: it is the 43-record case. A second 43-record case is a forked copy of the same conversation (the first 42 text hashes are identical).
- Compaction boundary BETWEEN the records: none (0 of 11). Compaction record immediately BEFORE the first occurrence: 3 of 11 (the main-thread cases: both 43-record cases and the 9-record case). In those three, the `isCompactSummary` record (user type, `isVisibleInTranscriptOnly: true`) carries the SAME promptId as every later marker record, and sits 18-19 lines before the first of them. The 8 sidechain/meta cases have no compaction near them (nearest compaction is 64 to over 1500 lines earlier, with a different promptId, or there is none in the file).
- Same text repeating: no. In all 11 cases every text hash is distinct (hash comparison only, no text printed). The reuse is of the promptId, not of the text.
- Human submission after a compaction under the compaction's promptId: yes, in the 3 main-thread cases (6 human records in the 9-record case, 2 in each 43-record case). Their text differs each time.

### Link from post-compaction records to pre-compaction ones
Over all 110 compaction pairs in the transcripts (boundary and summary):
- `system` record, `subtype: compact_boundary`: `parentUuid` is null in 110 of 110; `logicalParentUuid` is present in 110 of 110 and resolves to an earlier record in the same file in 96 (the other 14 point outside the file). It has no `promptId`. Other keys: `compactMetadata`, `content`, `level`, `isMeta`, `slug`, optionally `sessionKind`/`agentId`.
- `isCompactSummary` user record: `parentUuid` is the boundary record's uuid (resolves in 110 of 110), no `logicalParentUuid`, has `promptId` (110 of 110), `isVisibleInTranscriptOnly: true` (110 of 110); some also have `turnPosition` (69) or `turnOrigin` (13).
- Every boundary has a child record whose `parentUuid` is its uuid. So the chain is: pre-compaction record, linked only by `logicalParentUuid` on the boundary; boundary (`parentUuid` null); summary; later records.
- The only field joining post-compaction submissions to the compaction event besides that chain is the shared `promptId` stamped from the summary onto each following submission.

### Windows (`contiguous-reuse.jsonl`)
Each record keeps only: type, subtype, uuid, parentUuid, logicalParentUuid, promptId, isSidechain, isMeta, isCompactSummary, isVisibleInTranscriptOnly, level, origin (constant sub-fields), promptSource, turnOrigin, message.role, content shape (text kept only for harness constants, otherwise `REDACTED`; tool_use/tool_result reduced to type, tool name and remapped ids), timestamp shifted to 2026-01-01. System `content` is `REDACTED`. Ids are remapped consistently across the whole file.
Windows run from 2 records before the first occurrence to 2 after the last; where the shared-promptId compaction summary is earlier, the window starts 2 records before it. Windows over 60 records keep only marker records, system and compaction records, the window's first and last two records, and one neighbour on each side of those; the elided count is stated.

| Lines | Case | Records kept | Elided | Description |
|---|---|---|---|---|
| 1-56 | task-notification + human, main thread | 56 | 236 | queue-operation, compact_boundary (has `logicalParentUuid`), compact summary (promptId P, visible-only), then one assistant turn, then alternating human (`typed`/`human`) and task-notification (`system`/`task_notification`) submissions, every one carrying P. Each submission is followed by attachment, assistant, `stop_hook_summary` and `turn_duration` system records. |
| 57-306 | 3 kinds, main thread | 250 | 974 | same opening (boundary, summary P), then 40 task-notification submissions interleaved with 2 human ones, all under P; ends with an isMeta peer submission (`system`/`peer`). |
| 307-319 | peer only, sidechain | 13 | 0 | two isMeta peer submissions (no promptSource/turnOrigin) under one promptId, with assistant and tool_result user records (also same promptId) between them. |
| 320-328 | task-notification + coordinator, sidechain | 9 | 0 | isMeta task-notification submission then isMeta coordinator submission, two assistant turns between, same promptId. |
| 329-367 | task-notification only, sidechain | 39 | 0 | two isMeta task-notification submissions about 30 records apart, a run of tool_result user records between them, all one promptId. |
| 368-387 | coordinator only, sidechain | 20 | 0 | two isMeta coordinator submissions with tool_result user records between them. |

The fork copy of the 3-kind case and the other task-notification + coordinator and task-notification-only cases were not extracted (same shapes as above).
