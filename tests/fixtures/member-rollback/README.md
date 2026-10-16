# Previous member compatibility fixture

This frozen Bun module exports the origin/main registry lookup, credential resolver and auto-join hold from the commit in manifest.json, including their transitive runtime dependencies. Tests copy it into their private temporary directory and execute it against homes written by the current member. The manifest pins the bundle bytes and original entry-module bytes.

Rebuild from that commit with Bun 1.4.0: create an entry exporting readRegistryEntryResult from member/registry.ts, resolveCredential from member/credential.ts and autoJoinHold from member/auto-join-hook.ts; bundle with bun build --target bun --minify-syntax --minify-whitespace and that checkout's tsconfig.json. Update the bundle and manifest together. It is test data; it is not imported by the shipped member.
