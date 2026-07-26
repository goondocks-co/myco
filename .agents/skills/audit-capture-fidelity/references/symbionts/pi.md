# pi — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/pi.yaml`. Nothing declared there is repeated here.

**Capture model: plugin-reported.** A Myco extension at `~/.pi/agent/extensions/myco/index.ts` posts complete events straight to the daemon (`/sessions/register`, `/events`, `/events/stop`, `/context`). Nothing is mined.

## What this means for the audit

- **A NULL `transcript_path` is correct**, not data loss. Pi sessions legitimately have none.
- Transcript reconciliation does not apply and the audit reports a coverage gap rather than findings.
- Vault-integrity, closure and consistency checks still apply normally.

Pi *does* write its own transcripts (`~/.pi/agent/sessions/<project-slug>/<ts>_<sessionId>.jsonl`), but Myco does not consume them — they are the agent's own record. Declaring `transcriptDiscovery` for pi would be wrong: it would make the audit reconcile files that capture is not responsible for, generating findings for working-as-designed behavior.

## Other notes

- **Sweep-closing** — no SessionEnd hook.
- Pi has no native MCP transport; Myco tools are dispatched through the CLI (`tool call <name> --json`). A tool-visibility problem here is a transport issue, not a capture issue.
