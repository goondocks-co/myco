# opencode — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/opencode.yaml`. Nothing declared there is repeated here.

**Capture model: plugin-reported.** A Myco plugin at `~/.config/opencode/plugins/myco.ts` posts complete events to the daemon. Nothing is mined.

## There is no transcript at all

`opencode/plugin.ts` states it directly: *"Opencode has no on-disk transcript for Myco to mine."* OpenCode stores one JSON file **per message**:

```
$OPENCODE_DATA_DIR/storage/message/<sessionId>/msg_<id>.json   # default ~/.local/share/opencode
$OPENCODE_DATA_DIR/storage/session/<hash>/<sessionId>.json
$OPENCODE_DATA_DIR/storage/part/<messageId>/
```

There is no single file a `transcript_path` could point at. **A NULL `transcript_path` is correct.**

`~/.opencode/` holds only `bin/` and `node_modules/` — the data is under `$OPENCODE_DATA_DIR`. Looking in the wrong place and finding nothing has previously been misread as "opencode writes no transcripts".

## What this means for the audit

- Transcript reconciliation does not apply; the audit reports a coverage gap.
- Because there is no transcript, images attached by the user are captured by the plugin at attach time rather than extracted at stop time as for claude-code and cursor.
- **Sweep-closing** — no SessionEnd hook.
