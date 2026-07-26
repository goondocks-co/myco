# antigravity — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/antigravity.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. **Sweep-closing** — no SessionEnd hook.

Note that `hooksFormat: plugin-file` here does **not** mean plugin-reported. Antigravity uses a plugin bundle for hook delivery *and* has its transcripts mined. Hook format never identifies the capture model — adapter registration does.

## Format notes

- Data lives under `~/.gemini/`, not `~/.antigravity/` (which holds only editor extensions). Three surfaces write conversations — `antigravity-cli`, `antigravity`, `antigravity-ide` — and the manifest declares them in that precedence order. The same conversation id appearing under more than one surface resolves to the first.
- The transcript sits at a deep fixed leaf: `<surface>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`.
- Session id is `conversationId`, and hook fields are **camelCase** (`transcriptPath`, `artifactDirectoryPath`) rather than snake_case.

## Limitations

- No project attribution inside the transcript; orphans are a coverage gap.

## Hand-verification

```bash
for s in antigravity-cli antigravity antigravity-ide; do
  echo "$s: $(ls ~/.gemini/$s/brain 2>/dev/null | wc -l) conversations"
done
```
