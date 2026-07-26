# cline — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/cline.yaml`. Nothing declared there is repeated here.

**Capture model: plugin-reported.** A Myco plugin at `~/.cline/plugins/myco.ts` posts events to the daemon. Nothing is mined.

## Notes

- **A NULL `transcript_path` is correct**; transcript reconciliation does not apply.
- Cline keeps its own per-session directories at `~/.cline/data/sessions/<ts>_<rand>/` holding `<id>.json` and `<id>.messages.json`. Myco does not consume them.
- Session id is `conversationId`.
- User prompts arrive wrapped in a mode envelope — `<user_input mode="act">` or `<user_input mode="plan">` — which the manifest strips so the stored prompt is the user's text alone. These are the only two text-keyed rules cline declares, so `manifest-rule-never-matched` here means the envelope changed.
- **Sweep-closing** — no SessionEnd hook.

## Coverage

Cline support is the thinnest of the nine. Because rule replay needs a transcript source and cline has none, rule rot **cannot** be detected for it — the audit says so explicitly rather than reporting it clean.
