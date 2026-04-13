# Wisdom Consolidation Patterns

When you notice patterns in vault spores — recurring themes, conflicting advice, outdated observations — use these tools to keep the vault clean and its knowledge sharp.

## Automatic Intelligence

Myco automatically checks for supersession every time a new spore is written. After the spore is saved and embedded, a fire-and-forget pipeline searches for semantically similar active spores of the same observation type and asks the LLM whether any are now outdated. If so, they're marked superseded automatically. This means most vault hygiene happens without manual intervention.

For vault-wide cleanup (e.g., after a large refactor), use the CLI:
```sh
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js agent --dry-run  # preview
node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js agent             # execute
```

## Supersede

Use `myco_supersede` for manual supersession when you spot a stale spore that automatic intelligence missed.

**Signals:**
- A decision was reversed in a later session
- A gotcha was fixed and is no longer relevant
- A discovery turned out to be wrong or incomplete
- The codebase changed and an observation no longer applies

**Example flow:**
1. You find spore `decision-abc123` saying "we chose bcrypt for password hashing"
2. A newer spore `decision-def456` says "migrated from bcrypt to argon2 for better side-channel resistance"
3. Supersede the old one:
```json
{
  "old_spore_id": "decision-abc123",
  "new_spore_id": "decision-def456",
  "reason": "Auth migrated from bcrypt to argon2"
}
```

The old spore stays in the vault (data is never deleted) but its frontmatter is marked `status: superseded` with a link to the replacement. Search results deprioritize superseded spores.

## Consolidate

Use `myco_consolidate` when multiple spores describe aspects of the same insight and would be more useful as a single comprehensive note.

**Signals:**
- Three gotchas about the same subsystem that share a root cause
- Multiple discoveries about the same library that, together, form a complete picture
- A bug fix and a gotcha that describe the same issue from different angles
- Several trade-off spores about the same architectural decision

**Example flow:**
1. You find three related gotchas:
   - `gotcha-aaa111`: "SQLite WAL mode requires shared memory — fails in Docker"
   - `gotcha-bbb222`: "SQLite locks on concurrent writes from multiple processes"
   - `gotcha-ccc333`: "SQLite FTS5 tokenizer doesn't handle CamelCase"
2. Consolidate them into a wisdom note:
```json
{
  "source_spore_ids": ["gotcha-aaa111", "gotcha-bbb222", "gotcha-ccc333"],
  "consolidated_content": "# SQLite Operational Gotchas\n\nThree key constraints when using SQLite in production:\n\n1. **WAL mode + Docker**: WAL requires shared memory (mmap). Containers with `--tmpfs` or read-only root filesystems break this. Mount the database directory as a named volume.\n\n2. **Concurrent write access**: SQLite serializes all writes through a single writer lock. Multiple processes writing concurrently will get SQLITE_BUSY. Use a single long-lived process (the daemon) for all writes.\n\n3. **FTS5 tokenization**: The default tokenizer splits on non-alphanumeric characters, so CamelCase identifiers like `getUserById` are indexed as one token. Use the `unicode61` tokenizer with `tokenchars` to handle this.",
  "observation_type": "gotcha",
  "tags": ["sqlite", "infrastructure"]
}
```

The source spores are marked `status: superseded` with links to the wisdom note. The wisdom note has `consolidated_from` in its frontmatter linking back to its sources.

## When NOT to act

- **Don't consolidate unrelated spores** that happen to share tags — they should remain separate observations
- **Don't supersede a spore just because it's old** — age alone isn't a reason; the content must be outdated or replaced
- **Don't force consolidation for fewer than 3 sources** — two related spores are fine as separate notes; consolidation adds value when there's a pattern across 3+
- **Don't consolidate across observation types** unless they truly describe the same insight from different angles (e.g., a bug_fix and a gotcha about the same issue is fine)
