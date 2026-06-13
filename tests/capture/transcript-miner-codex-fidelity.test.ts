/**
 * Codex miner fidelity — end-to-end over a production-shaped rollout.
 *
 * One transcript exercises three RCs at once:
 *  - RC-B: a `$skill` expansion (second user-role response_item) folds into
 *    the human turn, so the assistant's answer lands on the HUMAN batch and
 *    the envelope system batch keeps a NULL summary.
 *  - RC-F: Codex `update_plan` calls remain transient task progress. They
 *    count as tool calls but never become persisted response_summary content
 *    or captured Plan rows.
 *  - RC-D(2): images carried on the turn reach the injected mining-path
 *    capture sink, attributed to the matched batch with the batch's own
 *    project tenancy.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { TranscriptMiner, type MinedImageCapture } from '@myco/capture/transcript-miner.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch, listBatchesBySession } from '@myco/db/queries/batches.js';
import { extractTaggedPlans } from '@myco/daemon/plan-capture.js';
import { codexAdapter } from '@myco/symbionts/codex.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const epochNow = () => Math.floor(Date.now() / 1000);

const PROJECT_ID = `proj_${'ab'.repeat(16)}`;

/** 1x1 transparent PNG encoded as base64 — smallest valid PNG. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZuUKhUAAAAASUVORK5CYII=';

const HUMAN_PROMPT = 'Run the review skill and plan the fixes';
const SKILL_ENVELOPE = '<skill>\n# Review skill\nFollow the procedure…\n</skill>';
const PROSE = 'Review complete. Two findings, both fixed.';

function buildRollout(): string {
  const entries = [
    { timestamp: '2026-06-12T10:00:00Z', type: 'session_meta', payload: { id: 'rollout-1', source: 'vscode' } },
    {
      timestamp: '2026-06-12T10:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: HUMAN_PROMPT },
          { type: 'input_image', image_url: `data:image/png;base64,${PNG_1x1}` },
        ],
      },
    },
    {
      timestamp: '2026-06-12T10:00:02Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SKILL_ENVELOPE }] },
    },
    {
      timestamp: '2026-06-12T10:00:10Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        arguments: JSON.stringify({ plan: [
          { step: 'Fix finding one', status: 'completed' },
          { step: 'Fix finding two', status: 'in_progress' },
        ] }),
      },
    },
    {
      timestamp: '2026-06-12T10:00:30Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PROSE }] },
    },
  ];
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('TranscriptMiner — codex fidelity (RC-B / RC-F / RC-D mining path)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  const sessionId = 's-codex-fidelity';

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fidelity-'));
    transcriptPath = path.join(tmpDir, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, buildRollout());
    const now = epochNow();
    upsertSession({ id: sessionId, agent: 'codex', project_id: PROJECT_ID, started_at: now, created_at: now });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function seedLiveBatches() {
    const now = epochNow();
    const human = insertBatch({
      session_id: sessionId, prompt_number: 1, user_prompt: HUMAN_PROMPT,
      origin: 'human', started_at: now, created_at: now,
    });
    const envelope = insertBatch({
      session_id: sessionId, prompt_number: 2, user_prompt: SKILL_ENVELOPE,
      origin: 'system', started_at: now, ended_at: now, created_at: now,
    });
    return { human, envelope };
  }

  it('response lands on the HUMAN batch without plan envelopes; the skill envelope batch stays NULL; images reach the sink', () => {
    const { human, envelope } = seedLiveBatches();
    const sinkCalls: MinedImageCapture[] = [];
    const miner = new TranscriptMiner({
      planTags: ['proposed_plan'],
      captureImages: (input) => sinkCalls.push(input),
    });

    const result = miner.reconcileAndAttributeResponses(sessionId, {
      agent: 'codex',
      transcriptPath,
    });
    expect(result.skippedReason).toBeUndefined();

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    const humanRow = batches.find((b) => b.id === human.id)!;
    const envelopeRow = batches.find((b) => b.id === envelope.id)!;

    // RC-B: the human prompt's turn owns the assistant output.
    expect(humanRow.response_summary).toContain(PROSE);
    // RC-F: no transient task-progress payload in the user-facing summary.
    expect(humanRow.response_summary).not.toContain('<update_plan>');
    expect(humanRow.response_summary).not.toContain('</update_plan>');
    // RC-B: an envelope batch matches no transcript turn — NULL is correct.
    expect(envelopeRow.response_summary).toBeNull();

    // RC-D(2): the turn's image was attributed to the matched human batch,
    // with tenancy from the batch row itself.
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0].sessionId).toBe(sessionId);
    expect(sinkCalls[0].promptBatchId).toBe(human.id);
    expect(sinkCalls[0].promptNumber).toBe(1);
    expect(sinkCalls[0].projectId).toBe(PROJECT_ID);
    expect(sinkCalls[0].images).toEqual([{ mediaType: 'image/png', data: PNG_1x1 }]);
  });

  it('update_plan task progress does not synthesize a durable transcript plan', () => {
    seedLiveBatches();
    const miner = new TranscriptMiner({ planTags: ['proposed_plan'] });
    miner.reconcileAndAttributeResponses(sessionId, { agent: 'codex', transcriptPath });

    const turns = codexAdapter.parseTurns(fs.readFileSync(transcriptPath, 'utf-8'));
    expect(turns).toHaveLength(1); // RC-B: envelope folded, single turn
    expect(turns[0].toolCount).toBe(1);
    expect(turns[0].aiResponse).toBe(PROSE);
    expect(turns[0].aiResponse).not.toContain('<update_plan>');
    expect(extractTaggedPlans(turns[0].aiResponse!, ['proposed_plan'])).toEqual([]);
  });

  it('an envelope-only assistant turn persists no summary at all', () => {
    // Rollout where the assistant emitted ONLY an update_plan call.
    const entries = [
      { timestamp: '2026-06-12T11:00:00Z', type: 'session_meta', payload: { id: 'rollout-2', source: 'vscode' } },
      {
        timestamp: '2026-06-12T11:00:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'plan only please' }] },
      },
      {
        timestamp: '2026-06-12T11:00:10Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Only step', status: 'pending' }] }),
        },
      },
    ];
    fs.writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const now = epochNow();
    const batch = insertBatch({
      session_id: sessionId, prompt_number: 1, user_prompt: 'plan only please',
      origin: 'human', started_at: now, created_at: now,
    });

    const miner = new TranscriptMiner({ planTags: ['proposed_plan'] });
    miner.reconcileAndAttributeResponses(sessionId, { agent: 'codex', transcriptPath });

    const row = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).find((b) => b.id === batch.id)!;
    expect(row.response_summary).toBeNull(); // stripped to '' → filtered, not persisted
  });
});
