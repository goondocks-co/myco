# File references in prompt recall

The member asks for memory with the typed prompt followed by opening text from
explicit local file references. This is selection input only. A prompt carrying
its own task keeps that text first, even when it also names files.

## Recognizing references

The shared prompt parser recognizes absolute paths (including Windows drive
paths), `~/` paths, `./` and `../` paths, paths with directory separators, and
bare filenames with an extension. Quotes and backticks allow spaces. `@path`
mentions and Markdown link destinations use the same rule. A final period or
colon is punctuation. References are considered in appearance order; aliases
of the same resolved filename are read once. Bare extensionless prose words,
URLs, bare email addresses, globs, shell variables and attachment ids are not paths.
An extensionless file can be named with `./`, `@`, or quotes.

The titling material builder uses this parser to match a stored tool read to
its prompt. It reads the captured opening, never the member's filesystem.

## Local read policy

Only an explicitly referenced regular file can contribute. Relative names use
the hook's working directory. Allowed roots are:

- The session's connected project root, or its working directory when no root
  is held by the credential.
- The machine's temporary folders, including `MYCO_TEMPORARY_FOLDERS` when set.
- A named non-hidden directory directly under the member's home, or its
  `XDG_STATE_HOME` (default `.local/state`). A file directly in home is excluded.
  Naming a file grants no recursive scan or reads of adjacent files.

The reader resolves the allowed root and rejects any symbolic link below it,
including links to other allowed directories. Home work roots themselves must
be physical descendants of home. The capture scratchpad exclusion applies to
both lexical and physical file paths through the capture policy's shared
predicate. Credential names, key files, `.env` files and private state such as
`.git`, `.ssh` and `.myco` are excluded. No directory enumeration occurs.

Known image, PDF, archive, media, font, executable and database suffixes are
excluded before opening. The opening must be valid UTF-8 without binary control
bytes; a PDF signature is also rejected. Unsupported encodings and ambiguous
binary content contribute no opening. The filename remains in the typed prompt.

## Bounds and storage

One isolated reader process performs a single opening read per qualifying file, at most 16 KiB and contributes
at most 4,096 characters. All added headings and text share an 8,192-character
cap. The entire ask remains within the existing 16,384-character limit, with
the typed prompt taking priority. The Deployment's embedding adapter independently
limits provider input to its first 8,000 characters. Reader startup and all file work share 50 ms, clipped to the
hook's remaining deadline. Expiry, missing files and read failures silently
leave the original ask, plus any earlier completed openings. The native process timeout kills the reader and closes its pipes at expiry; a blocked filesystem
operation cannot hold the hook's event loop open. Completed openings arrive as bounded UTF-8 on
private pipes, without membership credentials in the request. The compiled
member dispatches this private read operation before loading the CLI or native
Deployment assets. This is one deadline timer, with no polling or recurring job.

The observed memory-quality sample showed useful recall for 7 of 9 prompts
carrying tasks, and no useful items for the sampled pointer-only afternoon.
Those measurements motivate including opening text; they do not measure an
optimal cap. The caps above are a conservative initial bound: enough to reach
past a task's preamble while leaving space for mixed prompts and multiple files.

The member's private pending recall state holds the augmented request until
request settlement/delivery discards it, as it holds prompt asks today. The
capture event and transcript remain the typed text. The Deployment embeds the
augmented ask and stores its bounded text's hash, selected memory ids and plan
snapshots in the receipt. Answer diagnostics store identities, times, counts,
skips and classified errors. Neither store saves the ask text. Route telemetry
and member diagnostics contain no ask body. Session pages read the captured
prompt and the selected memory records, so they show no appended opening as
person-authored text. The embedding provider receives the augmented input.

## Harness evidence

The manifests, generated hook field mappings, hook templates and captured
prompt-hook fixtures declare no verified attachment-path field. Claude Code
and Codex supply `prompt`; Copilot and Cline map `prompt`; Windsurf maps
`tool_info.user_prompt`; Pi's extension and OpenCode's plugin explicitly pass
prompt text. Memory-capable hooks use the same member reader. Windsurf currently
captures its prompt without asking for memory. Cursor and Antigravity currently
wire no prompt-memory hook. Textual `@path` mentions are supported wherever
present in a prompt. Separate attachment-only payload fields are unsupported
until their path shape is verified and declared; no field names are guessed.
