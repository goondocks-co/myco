# copilot — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/copilot.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. Closes via a SessionEnd hook.

## One symbiont, two surfaces

The terminal `copilot` CLI and the VS Code Copilot extension drive the same agent runtime through the Copilot SDK, so one manifest covers both. A finding on "copilot" may originate in either.

## Format notes

- Layout is **directory-per-session** with a fixed entry file: `~/.copilot/session-state/<uuid>/events.jsonl`. The session id is the *directory* name, not the file name.
- The transcript is an **event log** (`user.message`, `assistant.message`, `tool.execution_start`), not a turn log — the parser reconstructs turns from events.

## History worth knowing

`copilot.ts` previously set `findTranscript: () => null` under a comment stating Copilot "doesn't have a predictable transcript directory". That was verified false on 2026-07-26 — the layout above is stable and predictable. That stale assumption is the most likely reason copilot had zero captured sessions. If copilot capture still looks empty, confirm the manifest layout resolves before looking anywhere else.

## Limitations

- No project attribution inside the transcript; orphans are a coverage gap.
