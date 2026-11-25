# File references in prompt recall

Myco reads only plainly named task prose, only in approved locations, to choose
memory. Typed text remains first. Openings are optional selection input and
never enter persisted asks, captured prompt rows or transcripts.

## Recognizing references

Only names ending in `.md`, `.markdown`, `.mdx`, `.txt`, `.rst` or `.adoc`
(case insensitive) are references. This applies to bare names, prose paths,
quoted paths, Markdown destinations and `@` mentions alike. Quotes and backticks
allow spaces; a final period or colon is punctuation. Relative paths use the
hook's working directory; `~/` names a path under the machine's home.
References are processed in appearance order and resolved filenames only once.

URLs, email addresses, shell variables, globs, attachment ids and tokens with
other suffixes are not references. They start no reader process. A non-prose
asset's filename remains part of the typed prompt but its bytes are never read.
Separate attachment-only payload fields are unsupported until verified.

Titling has a different authority: it matches tool reads already captured.
Its existing boundary matcher is retained, including extensionless filenames,
and the prose parser additionally recognizes mentions such as `@docs/task.md`.
Titling never opens the member's files.

## Approved locations

A prose file must be under the session's credential project root, a machine
temporary folder, or an extra root approved through the machine setting
`capture.prompt_file_roots`. The default is an empty list. A machine's page offers
“Extra prompt file folders”; the existing machine settings writer validates the
list, and normal member deliveries carry changes into the cache without a new
session start.

Extra roots use `~/subfolder` syntax. Absolute paths are refused: the Deployment
cannot verify an absolute path against another machine's home. The home itself,
its ancestors, filesystem roots and `..` segments are refused on save and
ignored if found in cached data. A physical root that aliases the home or an
ancestor is also refused. There is no blanket permission for home work folders
or XDG state. With no credential root, the project is the root the environment
declares in `MYCO_PROJECT_ROOT`; a file in the working directory outside that
root is not read. With neither, the cwd is usable only when auto-join's
`isSafeProjectRoot` admits it on its own merits; otherwise nothing is opened.
A temporary folder that is the home, an ancestor of it or a filesystem root is
not a root, and neither is any root that resolves to one of those through a
link.

Only regular files with one hard link qualify. Symlinks below roots are refused,
including links into other approved directories. Approved home roots must be
physical descendants of home. The canonical capture scratchpad exclusion also
applies through temporary-folder aliases. Private path components are refused
under their own name and under that name with a prose suffix (`id_rsa.txt`,
`.netrc.md`), as are names containing secret, credential, creds, password,
passwd, pgpass, token or key. Binary suffixes, invalid UTF-8, binary control
bytes and PDF signatures are refused. Nothing is enumerated, and no adjacent
file is read.

The opening itself is checked before it is used. An opening that holds a
private-key block, a recognisable provider token (AWS, GitHub, Slack, Google,
an `sk-` key, a JWT) or a credential assignment such as `password: …` is not
sent, whatever the file is called.

What remains: a prose file can hold a secret with no recognisable name or form,
such as a password pasted into `notes.md`. The same text reaches the Deployment
when the agent reads that file and the session is captured. Here it is also
sent to the embedding provider, and before the agent has read anything.

## Bounds, requests and storage

The reader performs one opening read per qualifying file, at most 16 KiB,
keeping 4,096 characters. All additions share an 8,192-character cap. The ask
retains its existing 16,384-character limit with typed text taking priority;
the embedding adapter separately clips provider input to 8,000 characters.
The initial ten-file sample had openings no larger than 3,004 bytes; those
measurements establish coverage, not an optimal cap.

Openings exist only in memory at the HTTP send boundary. A queued ask contains
typed text and cwd/project-root metadata. A helper obtains the current approved
roots, reads openings and constructs its request body without replacing the
stored text. Killing a hook or helper, or ending a session, leaves no file
opening in pending recall state. A helper that never sends reads nothing.

One separate reader process isolates optional filesystem work from the hook or
helper. A promise timeout alone does not release Bun's blocked filesystem work.
Startup and reads share 50 ms, clipped to the request's remaining deadline;
missing, refused, failed or late reads leave the original ask and any earlier
completed openings. The native timeout kills an ordinarily blocked reader;
uninterruptible kernel I/O on a hard-mounted share was not measured. No polling
or recurring job is added. There is no reader process when the parser finds no
prose reference. A macOS arm64 compiled-hook measurement over 15 runs per case took 32.0 ms
median without a reference, 47.2 ms with one prose file and 44.6 ms with one
refused prose file. Each made one memory request; all 15 valid openings were
used, and no refused opening was sent. The no-reference case starts no reader.
A separate stalled-reader probe terminated at 52.9 ms. These are measurements,
not test timing thresholds.

The Deployment receives the augmented text and sends it to the embedding
provider. Receipts hold its hash, selected memory ids and plan snapshots;
diagnostics hold identities, times, counts and classified errors, not the ask
body. Session pages use captured typed prompts. File prose can also contribute
to the existing plan-intent nudge because it is part of selection input.

## Harness evidence

Claude Code and Codex supply `prompt`; Copilot and Cline map `prompt`; Pi and
OpenCode explicitly forward prompt text. Memory-capable hooks use the same send
path. Windsurf currently captures its prompt without asking for memory. Cursor
and Antigravity currently wire no prompt-memory hook. No attachment-path field
was verified in the manifests, hook mappings, templates or captured fixtures.
