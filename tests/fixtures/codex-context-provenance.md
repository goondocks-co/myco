# Codex context recording

This fixture retains message records from a real interactive Codex recording, through its first assistant message. The header retains only source and CLI version. Message keys, arrays, roles and content-block types are preserved. Text is replaced except for the envelope delimiters and AGENTS.md marker listed in the sidecar; timestamps and other strings are replaced. The source hash covers the native prefix, not the growing whole session. No private native recording is committed.
