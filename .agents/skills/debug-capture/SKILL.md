---
name: debug-capture
description: Diagnose missing Myco capture, held member spools, hook refusals, or missing Deployment sessions.
---

# Diagnose capture

Read `docs/architecture/myco-2.0.md` before attributing runtime ownership.

1. Run `myco doctor` and `myco member status` from the affected project. Confirm the selected member home, Deployment and Project. A folder name alone proves no destination.
2. Check the installed harness hooks or plugin through `src/symbionts/member-hooks.ts` and `src/symbionts/installer.ts`. Hooks build envelopes and append to `MemberSpool`; plugins route transcripts through `member/transcript-routing.ts`.
3. Inspect the named destination spool read-only. Use `member status` for held sessions, refusal codes, offline state and capture loss. Preserve spool bytes; never clear a refusal by deleting the queue.
4. Run `myco member drain` for that membership when delivery is authorized. A terminal refusal needs its named cause corrected; retry transient transport failures under the existing budget.
5. Compare the Deployment's session and ingest receipts with the member report. Server event processing and registered-runner work are separate from delivery. Trace server-side failures through `myco-server-debugging`.

Use `myco member export` to collect sanitized diagnostics. Capture bodies and credentials stay out of reports. Test changed hooks with an isolated home and the compiled binary, then inspect the real receipt path.
