# Codex 0.153.4 recording

This fixture comes from a real Parallels VM Codex session. It retains all nine response_item records from the original 22-record rollout. Text, timestamps and identifiers were replaced. Object keys, array lengths, value types and identifier references were preserved and compared recursively before commit. The JSON sidecar records source and redacted SHA-256 hashes. The private source transcript is not committed.

Observed item types are message, custom_tool_call and custom_tool_call_output. The custom tool output is an array of two input_text blocks. This recording does not establish coverage of local_shell_call, tool_search_call or web_search_call.

The pinned upstream [ResponseItem declaration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts) names the item variants. Its [FunctionCallOutputBody declaration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/FunctionCallOutputBody.ts) permits a string or an array of content items.
