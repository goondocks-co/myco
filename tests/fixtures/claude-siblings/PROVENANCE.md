# Claude Code user records that share a `promptId`: redacted real transcripts

These files are redacted copies of real Claude Code records. They were extracted read-only from 1,540 transcript files
in one person's Claude Code projects folder: session files and `subagents/agent-*.jsonl` files, Claude Code versions
2.1.149 to 2.1.303. The owner approved them as public test data on 2026-10-19 (#1894 PR 2b). `REPORT.md` is the
extraction's own report: what was searched, the counts behind every shape, and the harness constants.

| File | What it holds |
|---|---|
| `sidechain.jsonl` | Four groups, one per key set of a subagent's first record: the lead's record that shares its `promptId`, the subagent's dispatch (`isSidechain`, `agentId`, `parentUuid: null`), and the first assistant record after it. |
| `teammate.jsonl` | `<teammate-message>` records in lead files and in subagent files. |
| `unknown-siblings.jsonl` | 86 pairs (pair n is lines 2n-1 and 2n): an earlier record and a later one with the same `promptId` in the same file, one pair per distinct pair of shapes and one per distinct harness-constant signature. |
| `contiguous-reuse.jsonl` | Windows in source order around `promptId`s that two or more turn-opening records share. Long windows keep only the turn-opening, system and compaction records plus their neighbours, and the report states each window's elided count. |

## How they were redacted

- **Text and envelopes.** Every message text body is replaced by `REDACTED`, with surrounding whitespace kept. Envelope tags are kept with their attribute names, and attribute values are `REDACTED`.
- **Tool data.** Tool inputs, tool results, `toolUseResult`, thinking text, signatures and image data are replaced: strings by `REDACTED`, numbers by 0. Keys and booleans are kept.
- **Location fields.** `cwd`, `gitBranch` and `slug` are placeholders. `origin` keeps only its constant sub-fields.
- **Ids.** Every id (`uuid`, `parentUuid`, `logicalParentUuid`, `promptId`, `sessionId`, `session_id`, `agentId`, `requestId`, tool-use ids, message ids) is remapped to a fresh id of the same style, consistently within each file. Relations between records are therefore kept.
- **Timestamps.** Each group is shifted so that it starts at 2026-01-01, with relative offsets kept.
- **Kept verbatim, because they are Claude Code's own constants:**
  - field names and nesting, `type`, `subtype` and `version`;
  - flags (`isSidechain`, `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`, `turnCompanion`);
  - `promptSource`, `turnOrigin` and `origin.kind`;
  - the two interrupt-marker texts and built-in slash-command names.
- **Checks.** The files were grepped for the owner's name, home paths, email, domains and organisations, and for temporary paths and hosting URLs, with no hits. `npm run check:fixtures` scans them at every commit.

## How to read them

- **Pairs are samples, not transcripts.** Never concatenate pairs as one transcript. A record uuid can recur across pairs, and across files under different sessions.
- **Windows are in source order but elide records.** A test that needs tool continuity across a window supplies its own records.
- **Under `claude-v2`** the first record that claims a `promptId` owns it, and every other kept record is keyed on its own thread and uuid (`packages/myco-server/src/ingest/parsers/claude-code.ts`). `tests/meta/claude-v2-identity.test.ts` gives every record here a disposition.
