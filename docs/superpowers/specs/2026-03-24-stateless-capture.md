# Stateless Capture Layer — Design Spec

## Problem

The daemon's event handlers maintain in-memory state (`BatchStateMap`) that resets on daemon restart, causing:
- Duplicate `prompt_number` values on batches
- Orphaned batches (created but never closed)
- `response_summary` not mapping correctly to batches
- `currentBatchId` lost, so tool activities link to wrong batches

The root cause: the daemon treats itself as a stateful server when it should be a stateless event processor. Everything needed to handle an event comes in the hook payload + the database.

## Design Principles

1. **Each hook event is self-contained** — `session_id` comes with every payload
2. **The database is the only state** — no in-memory maps, no recovery logic
3. **Append-only writes** — UserPromptSubmit inserts, PostToolUse inserts, Stop updates
4. **Hooks provide the data, transcript fills gaps** — use hook payloads for everything available; transcript only for AI responses and images (data hooks can't deliver)

## Current Architecture (broken)

```
UserPromptSubmit → read BatchStateMap → close prev batch → insert new batch → update map
PostToolUse      → read BatchStateMap → get currentBatchId → insert activity
Stop             → read BatchStateMap → close batch → mine transcript → update session
```

In-memory `BatchStateMap` is the single point of failure. Daemon restart = state loss = duplicates.

## Target Architecture

```
UserPromptSubmit → query latest open batch → close it → insert new batch (prompt_number from DB)
PostToolUse      → query latest open batch → insert activity with batch_id
Stop             → query latest open batch → close it → mine transcript → populate responses + images
```

Every handler does one DB query to find the current batch, then appends. No map, no recovery.

## Tasks

### Task 1: Add `getLatestOpenBatch` to batches.ts

```typescript
export async function getLatestOpenBatch(sessionId: string): Promise<{ id: number; prompt_number: number } | null> {
  // SELECT id, prompt_number FROM prompt_batches
  // WHERE session_id = $1 AND ended_at IS NULL
  // ORDER BY id DESC LIMIT 1
}
```

### Task 2: Add `getNextPromptNumber` to batches.ts

```typescript
export async function getNextPromptNumber(sessionId: string): Promise<number> {
  // SELECT COALESCE(MAX(prompt_number), 0) + 1 FROM prompt_batches WHERE session_id = $1
}
```

### Task 3: Rewrite `handleUserPrompt` — stateless

Remove `batchState` parameter. Replace with:
1. `getLatestOpenBatch(sessionId)` → close it if exists
2. `getNextPromptNumber(sessionId)` → use as prompt_number
3. `insertBatch(...)` → return new batch id
4. `updateSession(sessionId, { prompt_count })` → increment

No BatchStateMap read or write.

### Task 4: Rewrite `handleToolUse` — stateless

Remove `batchState` parameter. Replace with:
1. `getLatestOpenBatch(sessionId)` → use its id as `prompt_batch_id`
2. `insertActivity(...)` with the batch id (or null if no open batch)

### Task 5: Rewrite `handleSessionStop` — stateless

Remove `batchState` parameter. Replace with:
1. `getLatestOpenBatch(sessionId)` → close it if exists
2. `closeSession(sessionId, now)`

### Task 6: Remove `BatchStateMap` and `SessionBatchState`

- Delete the type definitions
- Delete the `batchState` map instantiation in `main()`
- Remove from all handler signatures
- Remove from `batchState.delete()` in unregister handler

### Task 7: Update `processStopEvent` — response_summary from transcript

The current `populateBatchResponses` maps by batch insertion order which is correct. Keep it. But also:
- Store `last_assistant_message` on the most recent batch via `getLatestOpenBatch` (before closing it)
- Link attachments to batches using `getBatchIdByPromptNumber` (already done)

### Task 8: Remove `recoverBatchState` from batches.ts

No longer needed — there's nothing to recover when every handler is stateless.

### Task 9: Update tests

- `tests/daemon/main.test.ts` — remove `batchState` from handler call signatures
- Verify that `handleUserPrompt` called twice assigns sequential prompt_numbers
- Verify daemon restart doesn't create duplicate prompt_numbers

### Task 10: Enhanced mid-turn capture (future — separate branch)

Claude-specific: read the JSONL transcript incrementally during the session via the adapter. This would give us AI responses as they happen, not just at stop time. Out of scope for this plan.

## Migration

No schema changes needed. The `prompt_batches` table already has all required columns. The `BatchStateMap` is purely in-memory — removing it has no migration impact.

Duplicate batches from prior daemon restarts can be cleaned with:
```sql
-- Find and remove duplicate batches (keep the first by id for each prompt_number)
DELETE FROM prompt_batches WHERE id NOT IN (
  SELECT MIN(id) FROM prompt_batches GROUP BY session_id, prompt_number
);
```

## Verification

After implementation:
1. `make check` passes
2. Start a session, submit 5 prompts, verify prompt_numbers are 1-5
3. `myco-dev restart` mid-session
4. Submit 3 more prompts, verify prompt_numbers are 6-8 (no duplicates)
5. Stop event populates response_summary on all batches
6. Images render inline in the correct batch cards
