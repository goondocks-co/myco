# Claude Code sibling lines that reuse the lead's `promptId`

`lead.jsonl` is a lead transcript: a person's prompt, a `Task` delegation, its tool result, and a
`<teammate-message>` line the harness writes under the lead's current `promptId`. `subagent.jsonl` is the delegated
agent's own transcript (`subagents/agent-<id>.jsonl` beside the lead's): `isSidechain: true`, its `agentId`, and the
lead's `promptId` on its first user line.

The record fields (`parentUuid`, `isSidechain`, `promptId`, `userType`, `entrypoint`, `cwd`, `sessionId`, `version`,
`gitBranch`, `uuid`, `timestamp`, `agentId`, `toolUseResult`) and the teammate envelope follow the Claude Code 2.1
records in `../claude-compact-continuation.jsonl` and the shapes `packages/myco/src/symbionts/manifests/claude-code.yaml`
declares (`agent_message`, `teammate_message`, `user_prompt`). The text, ids and times are written for this fixture:
no live subagent or teammate capture was available to the change that added it, so a redacted live capture should
replace these lines when one is taken.
