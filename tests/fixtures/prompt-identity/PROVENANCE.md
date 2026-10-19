# Prompt-identity evidence fixtures

Hook inputs for agents whose manifests declare `promptIdentity.kind: transcript-only` while wiring a prompt hook.
Each shows that the agent's prompt-submit input carries no per-submission key shared with its transcript.

- `codex-user-prompt-submit.json`: the UserPromptSubmit stdin `codex-cli 0.163.0` sent to a logging hook in a scratch
  `CODEX_HOME` on 2026-10-18. The session and turn ids are the observed ones; only the transcript path's scratch
  prefix is shortened. `turn_id` equals the rollout's `turn_context.payload.turn_id`, and one turn carries every
  steering submission, so it names a turn rather than a submission.
- `pi-user-prompt-submit.json`: the object the Pi extension's `before_agent_start` handler passes to the prompt hook
  (`packages/myco/src/symbionts/templates/pi/plugin.ts`), with placeholder session and path values: the session id,
  the transcript path, the prompt text and the working directory, and no prompt key.
