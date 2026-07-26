# windsurf — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/windsurf.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. **Sweep-closing** — no SessionEnd hook.

## Format notes

- Sessions are keyed by **trajectory id**, not a session id: the hook field is `trajectory_id` and the transcript is `<trajectoryId>.jsonl`. Flat directory, no nesting.
- Entry types are `user_input`, `planner_response`, `code_action` — unlike other agents there is no single `role` field.
- Hook payloads are **deeply nested** (`post_cascade_response_with_transcript`, `tool_info.*`), unlike Cursor's flat shape. Payload path divergence is the known failure mode here.

## Limitations

- No project attribution inside the transcript, so orphans are a coverage gap rather than a finding.
- Windsurf had **zero captured sessions** in the dogfood Grove while transcripts existed on disk. If that is still true, it is an install/hook problem, not a fidelity problem — start from `debug-capture`.

## Hand-verification

```bash
ls -t ~/.windsurf/transcripts/*.jsonl | head
jq -r '.type' <file> | sort | uniq -c
```
