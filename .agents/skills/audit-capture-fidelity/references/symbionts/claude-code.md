# claude-code — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/claude-code.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. Closes sessions via a SessionEnd hook, so a session left open past the stale threshold is a real finding, not the sweep waiting.

## Format notes

- Transcript entries carry `cwd` at the top level, which is how orphan transcripts get attributed to a project. It appears a couple of entries in, not on the first line.
- Slash-command dispatches land as a *pair* of user entries sharing one `promptId`: an XML wrapper (`<command-message>`/`<command-name>`/`<command-args>`) and the expanded body. The live hook capture is authoritative; the manifest drops both so the dispatch is not double-captured. A drop rule matching zero here is expected if the sample contains no slash commands.
- Internal CLI ops (`/compact`, `/clear`) appear as user entries starting with `<command-name>` rather than `<command-message>`. That one-character-class difference is the only structural signal separating them from real dispatches.
- Teammate reports arrive wrapped in an envelope tag. **This tag has been renamed once already** (`<teammate-message ` → `<agent-message from="…">`), silently reclassifying every teammate report as a human prompt. If `manifest-rule-never-matched` fires for claude-code, check this first.

## Hand-verification

```bash
# newest transcripts for a project
ls -t ~/.claude/projects/<slug>/*.jsonl | head

# what prompt-ish shapes exist in one
jq -r 'select(.type=="user") | .message.content | tostring | .[0:60]' <file> | sort | uniq -c | sort -rn | head
```

## Limitations

- Enumeration across all projects is large (2000+ transcripts here); the audit caps it and reports when the cap was hit.
- Sub-agent (Task tool) turns land on the parent session; they are not separate transcripts.
