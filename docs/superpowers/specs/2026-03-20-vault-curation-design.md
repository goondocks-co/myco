# Vault Curation: Automated Spore Supersession

## Problem

Spores become stale as the codebase evolves. A decision about "using the `model` field for unload" is accurate when written, but after a fix changes it to `instance_id`, the old spore is wrong. The digest engine doesn't filter by status, so it synthesizes from outdated spores, producing confident but incorrect summaries. Search and recall already filter superseded spores, but the digest does not, and nothing automatically identifies stale spores in the first place.

## Design

### The Supersession Pipeline

A single function `checkSupersession` in `src/vault/curation.ts` that takes a newly written spore and determines if it replaces any existing spores:

1. **Candidate search**: Embed the new spore's content via the embedding provider, then vector-search for similar spores (`type: 'spore'`). Post-filter results using the FTS index to keep only active spores with the same `observation_type` — the vector index has no status or observation_type columns. Over-fetch from the vector index (e.g., top 20) to ensure at least `SUPERSESSION_CANDIDATE_LIMIT` candidates survive post-filtering.
2. **LLM evaluation**: Send a prompt with the new spore and candidates, asking whether the new observation renders any of the older ones factually outdated or incorrect. The prompt must distinguish between "replaces" and "merely related" — two spores about the same topic from different angles are not supersession candidates.
3. **Supersede**: For each ID the LLM identifies as replaced, call the existing supersede logic (mark `status: 'superseded'`, set `superseded_by`, append the Obsidian notice, re-index) AND delete the superseded spore from the vector index so it stops appearing as a candidate in future checks.

The function signature:

```typescript
async function checkSupersession(
  newSporeId: string,
  deps: {
    index: MycoIndex;
    vectorIndex: VectorIndex;
    embeddingProvider: EmbeddingProvider;
    llmProvider: LlmProvider;
    vaultDir: string;
    log?: LogFn;
  },
): Promise<string[]>  // returns IDs of superseded spores
```

Early-exit with `[]` when `vectorIndex` or `llmProvider` is unavailable, so vaults without embedding/LLM configuration degrade gracefully.

### Supersession Prompt

Located in `src/prompts/supersession.md`. The prompt must be model-agnostic — clear instructions, concrete examples of what IS and ISN'T supersession, and structured JSON output. The LLM returns a JSON array of superseded spore IDs (or `[]` if none).

Max output tokens: `SUPERSESSION_MAX_TOKENS` constant in `constants.ts` (small — the response is just a JSON array).

**Error handling for LLM response parsing:**
- Extract JSON from potentially wrapped text (local models often add preamble)
- Validate with Zod: `z.array(z.string())`
- Verify each returned ID exists in the index and has `status: 'active'` before superseding
- Fall back to `[]` on any parse failure — a missed supersession is better than a false one

The call uses the main intelligence LLM provider (not the digest provider), consistent with observation extraction and artifact classification.

### Digest Substrate Filtering

Add a status filter to `discoverSubstrate()` in `src/daemon/digest.ts`. After the existing extract filter, also exclude spores with non-active status:

```typescript
const filtered = notes
  .filter((n) => n.type !== EXTRACT_TYPE)
  .filter((n) => {
    if (n.type !== 'spore') return true;
    const status = n.frontmatter.status as string | undefined;
    return !status || status === 'active';
  });
```

Sessions, plans, artifacts, and team notes pass through unchanged. Only spores get the status check.

### Integration Points

Two entry points call the same pipeline, both fire-and-forget (never block the caller):

**Daemon batch processor** (`src/daemon/main.ts` — `writeObservations`): After writing each spore and firing off the embedding, also fire-and-forget `checkSupersession`. Same `.then()/.catch()` pattern as embedding. The daemon already has all required deps (index, vectorIndex, embeddingProvider, llmProvider).

**MCP `myco_remember` tool** (`src/mcp/tools/remember.ts`): After writing the spore and indexing it, fire-and-forget `checkSupersession`. This requires threading `vectorIndex`, `embeddingProvider`, and `llmProvider` through from the MCP server's tool dispatch — currently `remember.ts` only receives `vaultDir` and `index`.

### CLI: `myco curate`

For one-time vault cleanup and ongoing maintenance:

```
myco curate              # Scan all active spores, supersede stale ones
myco curate --dry-run    # Run LLM evaluation, print results without writing
```

The flow:

1. Query all active spores from the index.
2. Group by `observation_type` (decisions with decisions, gotchas with gotchas).
3. Within each group, find clusters of related spores by embedding each and checking pairwise vector similarity against a threshold (`CURATION_CLUSTER_SIMILARITY`). Use greedy nearest-neighbor clustering to avoid O(n^2) LLM calls — each spore joins the most similar existing cluster, or starts a new one.
4. For each cluster with 2+ spores, send to the LLM evaluation prompt to identify which are outdated given the others.
5. Supersede as identified.

`--dry-run` runs the full LLM evaluation but prints proposed supersessions instead of executing them. This is not a cheap operation — the LLM calls still happen — but it lets you review before the first vault-wide scan.

The command creates its own providers (following the pattern of `reprocess` and `digest` CLI commands) and uses the same `checkSupersession` pipeline in batch mode. Register in `src/cli.ts` switch-case.

### New Files

| File | Purpose |
|------|---------|
| `src/vault/curation.ts` | `checkSupersession` function and batch curation logic |
| `src/prompts/supersession.md` | LLM prompt template for supersession evaluation |
| `src/cli/curate.ts` | CLI command entry point |
| `tests/vault/curation.test.ts` | Tests for the supersession pipeline |

### Constants

| Constant | Purpose |
|----------|---------|
| `SUPERSESSION_CANDIDATE_LIMIT` | Max candidates after post-filtering (e.g., 5) |
| `SUPERSESSION_VECTOR_FETCH_LIMIT` | Over-fetch count for vector search before post-filtering (e.g., 20) |
| `SUPERSESSION_MAX_TOKENS` | Max output tokens for the LLM evaluation call |
| `CURATION_CLUSTER_SIMILARITY` | Similarity threshold for clustering in `myco curate` |

### What This Does NOT Do

- **Does not delete spores** — superseded spores are preserved with lineage metadata, consistent with the data preservation contract.
- **Does not add new config** — uses existing LLM provider and vector index. No new settings in `myco.yaml`.
- **Does not change the digest timer** — curation happens at spore write time, not during digest cycles. The digest just filters out what's already been superseded.
- **Does not run periodically** — no new daemon task or metabolism. The inline check on spore creation handles ongoing hygiene. The CLI handles catch-up.
