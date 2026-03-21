import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineManager, type StageHandlers } from '@myco/daemon/pipeline';
import { VaultWriter } from '@myco/vault/writer';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import { indexNote } from '@myco/index/rebuild';
import { formatSessionBody, CONVERSATION_HEADING } from '@myco/obsidian/formatter';
import { sessionNoteId, sessionRelativePath } from '@myco/vault/session-id';
import { ITEM_STAGE_MAP } from '@myco/constants';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pipeline integration tests: verifies the session stop → pipeline registration
 * flow matches what main.ts now does (Task 9).
 *
 * These tests exercise the same sequence the stop handler performs:
 * 1. Write session note with placeholder title + empty narrative (capture)
 * 2. FTS index the session note (searchable immediately)
 * 3. Register in pipeline + advance capture to succeeded
 * 4. Extraction is NOT called during capture — deferred to pipeline tick
 */
describe('Pipeline Integration: Session Stop → Pipeline Registration', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;
  let vault: VaultWriter;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pipeline-integ-'));
    pipeline = new PipelineManager(tmpDir);
    vault = new VaultWriter(tmpDir);
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    pipeline.close();
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stop event registers a work item with capture:succeeded', () => {
    const sessionId = 'test-session-abc123';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    // Simulate capture: write session note
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [{ prompt: 'Hello', toolCount: 0 }],
    });
    vault.writeSession({
      id: sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      summary,
    });

    // Register in pipeline and advance capture
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    // Verify pipeline state
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const captureStatus = statuses.find((s) => s.stage === 'capture');
    expect(captureStatus).toBeDefined();
    expect(captureStatus!.status).toBe('succeeded');

    // Extraction should still be pending (not yet processed)
    const extractionStatus = statuses.find((s) => s.stage === 'extraction');
    expect(extractionStatus).toBeDefined();
    expect(extractionStatus!.status).toBe('pending');

    // Embedding should be pending
    const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
    expect(embeddingStatus).toBeDefined();
    expect(embeddingStatus!.status).toBe('pending');
  });

  it('extraction is NOT called during stop event', async () => {
    const sessionId = 'test-session-def456';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    // Track handler invocations
    const extractionCalls: string[] = [];
    const embeddingCalls: string[] = [];
    const consolidationCalls: string[] = [];

    pipeline.setHandlers({
      extraction: async (itemId) => { extractionCalls.push(itemId); },
      embedding: async (itemId) => { embeddingCalls.push(itemId); },
      consolidation: async (itemId) => { consolidationCalls.push(itemId); },
    });

    // Simulate the stop event flow (capture only)
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [{ prompt: 'Build the pipeline', toolCount: 3 }],
    });
    vault.writeSession({
      id: sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      summary,
    });

    // Register and advance capture (what stop handler does)
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    // At this point, NO handlers should have been called —
    // they only run on pipeline tick
    expect(extractionCalls).toHaveLength(0);
    expect(embeddingCalls).toHaveLength(0);
    expect(consolidationCalls).toHaveLength(0);
  });

  it('session note is written to vault during capture', () => {
    const sessionId = 'test-session-ghi789';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      user: 'chris',
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      branch: 'feat/pipeline',
      turns: [
        { prompt: 'Implement pipeline registration', toolCount: 5, aiResponse: 'Done.' },
      ],
    });

    vault.writeSession({
      id: sessionId,
      user: 'chris',
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      branch: 'feat/pipeline',
      tools_used: 5,
      summary,
    });

    // Verify the session note file exists
    const fullPath = path.join(tmpDir, relativePath);
    expect(fs.existsSync(fullPath)).toBe(true);

    // Verify content has conversation section but placeholder title
    const content = fs.readFileSync(fullPath, 'utf-8');
    expect(content).toContain(`Session ${sessionId}`);
    expect(content).toContain(CONVERSATION_HEADING);
    expect(content).toContain('Implement pipeline registration');
    // No LLM-generated summary callout (narrative is empty)
    expect(content).not.toContain('[!abstract] Summary');
  });

  it('session note is FTS-indexed immediately after capture', () => {
    const sessionId = 'test-session-jkl012';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [
        { prompt: 'Search for pipeline bugs', toolCount: 2 },
      ],
    });

    vault.writeSession({
      id: sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      summary,
    });

    // FTS index (what the stop handler does)
    indexNote(index, tmpDir, relativePath);

    // Verify the note is searchable
    const results = index.query({ type: 'session' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The index stores the raw session ID from frontmatter (not the sessionNoteId prefix)
    const sessionResult = results.find((r) => r.id === sessionId);
    expect(sessionResult).toBeDefined();
  });

  it('pipeline tick processes pending extraction after capture:succeeded', async () => {
    const sessionId = 'test-session-mno345';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    const extractionCalls: Array<{ id: string; type: string; path: string | null }> = [];

    pipeline.setHandlers({
      extraction: async (itemId, itemType, sourcePath) => {
        extractionCalls.push({ id: itemId, type: itemType, path: sourcePath });
      },
      embedding: async () => {},
      consolidation: async () => {},
    });

    // Simulate stop event: register and advance capture
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    // Run a pipeline tick — should pick up the pending extraction
    await pipeline.tick(10);

    // Extraction handler should have been called
    expect(extractionCalls).toHaveLength(1);
    expect(extractionCalls[0].id).toBe(sessionId);
    expect(extractionCalls[0].type).toBe('session');
    expect(extractionCalls[0].path).toBe(relativePath);

    // Extraction stage should now be processing or succeeded
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const extractionStatus = statuses.find((s) => s.stage === 'extraction');
    expect(extractionStatus).toBeDefined();
    // The stub handler doesn't advance the stage, so tick marks it processing
    // then the handler succeeds, which means tick should advance to succeeded
    expect(extractionStatus!.status).toBe('succeeded');
  });

  it('session note has fallback title and no LLM summary', () => {
    const sessionId = 'test-session-pqr678';

    // Build session body the same way the stop handler does
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '', // Empty — no LLM summary yet
      sessionId,
      user: 'chris',
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:30:00Z',
      turns: [
        { prompt: 'First task', toolCount: 1 },
        { prompt: 'Second task', toolCount: 2, aiResponse: 'Completed.' },
      ],
    });

    // Verify the title is the session ID fallback
    expect(summary).toContain(`# Session ${sessionId}`);
    // Verify there's no summary callout
    expect(summary).not.toContain('[!abstract]');
    // Verify conversation turns are present
    expect(summary).toContain('### Turn 1');
    expect(summary).toContain('### Turn 2');
    expect(summary).toContain('First task');
    expect(summary).toContain('Completed.');
  });

  it('idempotent: re-registering same session is a no-op', () => {
    const sessionId = 'test-session-stu901';
    const relativePath = sessionRelativePath(sessionId, '2026-03-21');

    // Register twice (idempotent)
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    // Should still have exactly one set of stages
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const captureStatuses = statuses.filter((s) => s.stage === 'capture');
    // There may be multiple transition records, but the latest should be succeeded
    const latestCapture = captureStatuses[captureStatuses.length - 1];
    expect(latestCapture.status).toBe('succeeded');

    // Health totals should reflect a single work item (one row per stage)
    const { items } = pipeline.listItems({ type: 'session' });
    const uniqueIds = new Set(items.filter((i) => i.id === sessionId).map((i) => i.id));
    expect(uniqueIds.size).toBe(1);
  });

  it('consolidation stage is skipped for session work items', () => {
    const sessionId = 'test-session-vwx234';
    const relativePath = sessionRelativePath(sessionId, '2026-03-21');

    pipeline.register(sessionId, 'session', relativePath);

    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
    expect(consolidationStatus).toBeDefined();
    // Sessions skip consolidation per ITEM_STAGE_MAP
    expect(consolidationStatus!.status).toBe('skipped');
    // Verify the constant agrees
    expect(ITEM_STAGE_MAP['session']).not.toContain('consolidation');
  });
});
