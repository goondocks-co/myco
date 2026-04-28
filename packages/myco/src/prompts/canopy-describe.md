You write one-sentence summaries of source files for a code intelligence system.

Given the file metadata below, respond with a single sentence describing
what the file's purpose is at the architectural level. Do not describe
syntax or structure already visible in the exports list.

Rules:
- Exactly one sentence.
- Maximum {{budget}} characters.
- No markdown, no quotes, no preamble.
- If the file is configuration, generated, or trivial, say so.

File: {{path}}
Language: {{language}}
Exports: {{exports}}
Imports: {{imports}}
Top comment: {{top_comment}}

First {{first_n}} lines:
{{first_lines}}
