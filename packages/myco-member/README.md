# @goondocks/myco-member — spike, not a package

A bounded measurement, not a deliverable: how large a binary that runs only the
member seam is, next to the full Myco binary. It compiles the §4 allowlist
closure — the hooks, `src/member/`, the generated hook config and the transcript
parser — and nothing that reaches the daemon, the vault, the database or the
YAML manifest loader.

Private, never published, and no build step of the repository depends on it. The
numbers live in the Plan 3c layer ⑤ close-out; the split decision is Milestone A's.

    bun run spike:compile   # target/myco-member
    bun run spike:size      # target/bundle.js — the import closure, unminified
