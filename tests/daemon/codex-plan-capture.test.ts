/**
 * Integration test: Codex plan capture end-to-end.
 *
 * Verifies that a Codex transcript with <proposed_plan> tags
 * produces a captured plan in the database when processed through
 * the CodexJsonlParser -> stop processor pipeline.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { CodexJsonlParser } from '@myco/symbionts/parsers/codex-jsonl.js';
import { extractTaggedPlans, captureTaggedPlan } from '@myco/daemon/plan-capture.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { listPlansBySession } from '@myco/db/queries/plans.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('Codex plan capture integration', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  const planMarkdown = '# Collective V1 Plan\n\n## Summary\n\nBuild the collective layer.\n\n## Steps\n\n1. Create packages\n2. Deploy workers\n3. Wire settings';

  function buildCodexTranscript(planContent: string): string {
    return [
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'System instructions' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Build a plan for the collective' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `<proposed_plan>\n${planContent}\n</proposed_plan>` }],
        },
      }),
    ].join('\n');
  }

  it('parses Codex transcript, extracts plan tag, and captures to database', () => {
    const sessionId = 'codex-plan-integration-001';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });
    const batch = insertBatch({ session_id: sessionId, prompt_number: 1, user_prompt: 'Build a plan', started_at: now, created_at: now });

    // Step 1: Parse transcript
    const parser = new CodexJsonlParser();
    const transcript = buildCodexTranscript(planMarkdown);
    const turns = parser.parseTurns(transcript);

    expect(turns).toHaveLength(1);
    expect(turns[0].aiResponse).toContain('<proposed_plan>');

    // Step 2: Extract tagged plans
    const planTags = ['proposed_plan'];
    for (const turn of turns) {
      if (!turn.aiResponse) continue;
      const taggedPlans = extractTaggedPlans(turn.aiResponse, planTags);

      // Step 3: Capture each plan
      for (const { tag, content } of taggedPlans) {
        captureTaggedPlan({
          tag,
          content,
          sessionId,
          promptBatchId: batch.id,
        });
      }
    }

    // Step 4: Verify database state
    const plans = listPlansBySession(sessionId, ALL_PROJECTS_SCOPE);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Collective V1 Plan');
    expect(plans[0].content).toBe(planMarkdown);
    expect(plans[0].session_id).toBe(sessionId);
    expect(plans[0].prompt_batch_id).toBe(batch.id);
    expect(plans[0].source_path).toBe('transcript:proposed_plan');
  });

  it('revised plan upserts over original (same source path)', () => {
    const sessionId = 'codex-plan-integration-002';
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', started_at: now, created_at: now });

    // Capture original
    const original = captureTaggedPlan({
      tag: 'proposed_plan',
      content: '# Original Plan\n\nFirst version.',
      sessionId,
    });

    // Capture revision (same source path)
    const revised = captureTaggedPlan({
      tag: 'proposed_plan',
      content: '# Revised Plan\n\nSecond version.',
      sessionId,
    });

    // Same ID — upserted, not duplicated
    expect(revised.id).toBe(original.id);

    const plans = listPlansBySession(sessionId, ALL_PROJECTS_SCOPE);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Revised Plan');
    expect(plans[0].content).toBe('# Revised Plan\n\nSecond version.');
  });
});
