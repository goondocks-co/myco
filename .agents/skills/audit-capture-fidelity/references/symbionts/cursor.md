# cursor — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/cursor.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. Closes via a `sessionEnd` hook (lowercase — Cursor's event names are camelCase, unlike Claude Code's PascalCase).

## Format notes

- **Two layouts coexist.** Older Cursor wrote a flat `<sessionId>.txt`; newer nests `<sessionId>/<sessionId>.jsonl`. Both remain resolvable and the manifest declares `.txt` first, preserving the precedence the adapter used before discovery moved into the manifest. If you reorder them you change which file wins for a session that has both.
- The parser sniffs format by first character: `{` means JSONL, otherwise plain text starting `user:`.
- Hook payloads use a **flat** schema and the session id arrives as `conversation_id` or `session_id` — the manifest declares both, in order.

## Limitations

- **No project attribution inside the transcript.** The project is only in the containing directory name (`Users-chris-Repos-<name>`), which the audit does not currently parse, so orphan transcripts are reported as a coverage gap rather than a finding. Wiring this up would make cursor orphans reportable.

## Hand-verification

```bash
ls ~/.cursor/projects/*/agent-transcripts/ | head
```
