# OpenCode ACP recording

Captured September 12, 2026 from installed OpenCode 1.18.21, using a temporary directory and a synthetic local MCP server. The prompt requested exactly one fixture_receipt read followed by its receipt. Selected model: openai/gpt-5.6-sol.

The fixture contains inbound protocol messages only. Session, tool-call and message identifiers were replaced consistently. Available commands were removed and config option lists were reduced to the selected values. No request credentials, repository material, local paths, or provider credentials are included. Token counts, status ordering, and prompt response fields are unchanged.

The native session has two assistant responses: 10,172 input plus 16 output, then 222 fresh input plus 9,984 cached input plus 9 output. ACP reports only the last response. The full native total is 20,403; the ACP total is 10,215. Context used is 10,206 and context size is 400,000. The reported zero USD cost is not a billing statement.

Source checked at https://github.com/anomalyco/opencode/blob/v1.18.21/packages/opencode/src/acp/usage.ts and the identical v1.18.29 file. The generic protocol usage contract is at https://agentclientprotocol.com/rfds/session-usage. Other versions retain unverified token scope until compared with native evidence.
