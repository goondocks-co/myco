# Harness diagnostics fixtures

What each driver reads when a harness stops on a missing login, a rate limit, a timeout or a crash, for the gate in
`tests/member/worker-diagnostics.test.ts`. Each case is a harness's stdout lines, what it writes to stderr and its exit
status (or, for the agent protocol, its answer to `session/prompt`). `{{SECRET}}` is replaced by the test with a value
from the shared secret corpus, so each case also proves no word the harness said reaches the run's error.

- `claude-code.json` `login_missing` is recorded from Claude Code 2.1.285 (2026-10-02), run with
  `claude -p hi --output-format stream-json --verbose --strict-mcp-config` under an empty `CLAUDE_CONFIG_DIR` and an
  invalid `ANTHROPIC_API_KEY`. The ten `system/api_retry` lines are cut to the last, and each line to the fields the
  driver reads; the run took 183 s of retries before it ended.
- `codex.json` `login_missing` is recorded from codex-cli 0.160.0 (2026-10-02), run with
  `codex exec --json --skip-git-repo-check hi` under an empty `CODEX_HOME` and no login. The `Reconnecting… n/5`
  error lines are cut to the last, and stderr to its first two lines.
- Every other case is written to the shape its harness's stream takes (`recorded: false`): Claude Code's in-band
  `error` codes (`rate_limit`, `unknown`) with its API error text, Codex's `turn.failed` message and a Rust panic,
  and OpenCode's JSON-RPC error answer or a connection it closes mid-turn.
