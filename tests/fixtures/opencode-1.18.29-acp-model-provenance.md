# OpenCode ACP model selection recording

Captured October 2, 2026 from OpenCode 1.18.29 (`opencode acp`) on a test machine signed in to OpenAI, using a temporary directory, no MCP servers and `OPENCODE_PURE=1`. Each case is a separate `opencode acp` process given its configuration in `OPENCODE_CONFIG_CONTENT`. The run's agent was `myco-run-fixture`, with `permission: { "*": "ask" }`.

| Case | Configuration | Client calls |
|---|---|---|
| `default` | The run's agent names `model: openai/gpt-5.5`; no top-level model | `initialize`, `session/new` |
| `configured` | Top-level `model` and `small_model`: `openai/gpt-5.5` | `initialize`, `session/new` |
| `unknown` | Top-level `model` and `small_model`: `openai/gpt-0-unknown`, which no provider offers | `initialize`, `session/new` |
| `set-model` | As `default` | `initialize`, `session/new`, `session/set_config_option` (`model`, `openai/gpt-5.5`) |
| `prompt` | As `configured` | `initialize`, `session/new`, `session/set_config_option` (`effort`, `medium`), `session/prompt` |

The fixture holds the inbound protocol messages only. Session and message identifiers were replaced consistently, and `available_commands_update` notifications were removed. The configuration options, offered values, token counts and prompt responses are unchanged. The `prompt` turn's text was "Reply with the single word ok and nothing else. Use no tools."

What it shows: a session opens on the configuration's top-level model where a provider offers it, and otherwise on OpenCode's own default (`opencode/big-pickle`), whatever model the run's agent names. `session/set_config_option` moves a session to an offered model, and sets the effort among the values its model offers. The source is `defaultModelFromConfig` and the `prompt` handler in https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/acp/service.ts, which sends the session's model with every prompt.
