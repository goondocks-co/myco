# Cursor agent recording (cursor-agent 2026.09.28-64d2043)

This fixture is a real `cursor-agent -p … --trust` session recorded on the Parallels test VM on 2026-09-28 (issue #1461). It keeps all six lines of the original transcript. The only change is to paths: the home directory was replaced with `/Users/fixture/`. Before commit, the shape of every line (object keys, array lengths and value types) was compared with the source and found identical.

- Source SHA-256: `0393d84a30f17241d757383416f88d3da9abd0c69b1facdb5c2388aa7f943c67`
- Redacted SHA-256: `633cde634c277c740bcd85c863660c77f6b72207a5c5b4ac772bc107d32465ea`

Each line is `{"role": "user" | "assistant", "message": {"content": [...]}}` with `text` and `tool_use` blocks, and the turn closes with `{"type": "turn_ended", "status": "success"}`. The person's words sit inside `<user_query>`, next to a `<timestamp>` block the agent adds. No line carries a timestamp field.

The Cursor IDE agent (Cursor 3.22) writes the same format under `~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`. A survey of 96 IDE and CLI transcripts on a development machine found no other line shape. Across them, the user text wrapped in context blocks (`<timestamp>`, `<image_files>`, `<attached_files>`, `<external_links>`) outside `<user_query>`, and two user lines were injected context with no `<user_query>` at all (`<git_status>`, a subagent catalogue).
