import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineManager, type StageHandlers } from '@myco/daemon/pipeline';
import { VaultWriter } from '@myco/vault/writer';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import { indexNote } from '@myco/index/rebuild';
import { formatSessionBody, CONVERSATION_HEADING, extractSection, callout } from '@myco/obsidian/formatter';
import { sessionNoteId, sessionRelativePath } from '@myco/vault/session-id';
import { writeObservationNotes } from '@myco/vault/observations';
import { updateTitleAndSummary } from '@myco/services/vault-ops';
import { SUMMARIZATION_FAILED_MARKER } from '@myco/daemon/processor';
import { generateEmbedding } from '@myco/intelligence/embeddings';
import { EventBuffer } from '@myco/capture/buffer';
import { ITEM_STAGE_MAP, EMBEDDING_INPUT_LIMIT } from '@myco/constants';
import type { EmbeddingProvider, EmbeddingResponse } from '@myco/intelligence/llm';
import type { VectorIndex } from '@myco/index/vectors';
import YAML from 'yaml';
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

/**
 * Pipeline Integration: Extraction Stage Handler
 *
 * These tests exercise the extraction handler logic that runs on pipeline tick:
 * 1. Read buffer events + conversation markdown from the session note
 * 2. Extract observations (mock LLM)
 * 3. Generate summary + title (mock LLM)
 * 4. Write spore notes, update session note, register spores in pipeline
 */
describe('Pipeline Integration: Extraction Stage Handler', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;
  let vault: VaultWriter;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-extraction-integ-'));
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

  /** Helper: write a session note in capture stage (what processStopEvent does). */
  function writeSessionNote(sessionId: string, opts?: { user?: string }): string {
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      user: opts?.user,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:30:00Z',
      turns: [
        { prompt: 'Implement the pipeline extraction handler', toolCount: 5, aiResponse: 'Done implementing.' },
        { prompt: 'Write tests for it', toolCount: 3, aiResponse: 'Tests written and passing.' },
      ],
    });
    vault.writeSession({
      id: sessionId,
      user: opts?.user,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:30:00Z',
      summary,
    });
    indexNote(index, tmpDir, relativePath);
    return relativePath;
  }

  /** Helper: write buffer events for a session. */
  function writeBufferEvents(sessionId: string): void {
    const bufferDir = path.join(tmpDir, 'buffer');
    const buffer = new EventBuffer(bufferDir, sessionId);
    buffer.append({ type: 'tool_use', tool_name: 'Read', session_id: sessionId });
    buffer.append({ type: 'tool_use', tool_name: 'Edit', session_id: sessionId });
    buffer.append({ type: 'user_prompt', prompt: 'Implement extraction', session_id: sessionId });
  }

  it('extraction handler writes observation spore notes on success', async () => {
    const sessionId = 'test-extract-abc123';
    const relativePath = writeSessionNote(sessionId);
    writeBufferEvents(sessionId);

    // Register and advance capture
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    // Set up extraction handler that simulates real logic
    pipeline.setHandlers({
      extraction: async (itemId, itemType, sourcePath) => {
        if (itemType !== 'session') return;

        // Read buffer events
        const bufferDir = path.join(tmpDir, 'buffer');
        const buffer = new EventBuffer(bufferDir, itemId);
        const bufferEvents = buffer.readAll();
        expect(bufferEvents.length).toBeGreaterThan(0);

        // Read the session note
        const fullPath = path.join(tmpDir, sourcePath!);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');
        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;
        const conversationMarkdown = extractSection(body, CONVERSATION_HEADING);
        expect(conversationMarkdown).toContain('Implement the pipeline extraction handler');

        // Simulate LLM results (mock processor)
        const observations = [
          {
            type: 'discovery' as const,
            title: 'Pipeline extraction pattern',
            content: 'The extraction handler reads buffer events and conversation markdown.',
            tags: ['pipeline', 'extraction'],
          },
        ];

        // Write observation spore notes
        const written = writeObservationNotes(observations, itemId, vault, index, tmpDir);
        expect(written).toHaveLength(1);

        // Update session note with title + narrative
        const fmEnd = fileContent.indexOf('---', 4);
        const frontmatterBlock = fileContent.slice(0, fmEnd + 3);
        const updatedBody = updateTitleAndSummary(body, 'Pipeline Extraction Implementation', 'Implemented the extraction stage handler.');
        fs.writeFileSync(fullPath, frontmatterBlock + updatedBody, 'utf-8');

        // Re-index session note
        indexNote(index, tmpDir, sourcePath!);

        // Register spores in pipeline
        for (const note of written) {
          pipeline.register(note.id, 'spore', note.path);
          pipeline.advance(note.id, 'spore', 'capture', 'succeeded');
        }
      },
      embedding: async () => {},
      consolidation: async () => {},
    });

    // Run pipeline tick
    await pipeline.tick(10);

    // Verify extraction succeeded
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const extractionStatus = statuses.find((s) => s.stage === 'extraction');
    expect(extractionStatus).toBeDefined();
    expect(extractionStatus!.status).toBe('succeeded');

    // Verify spore files exist in vault
    const sporesDir = path.join(tmpDir, 'spores', 'discovery');
    expect(fs.existsSync(sporesDir)).toBe(true);
    const sporeFiles = fs.readdirSync(sporesDir);
    expect(sporeFiles.length).toBeGreaterThanOrEqual(1);

    // Verify spore content
    const sporeContent = fs.readFileSync(path.join(sporesDir, sporeFiles[0]), 'utf-8');
    expect(sporeContent).toContain('Pipeline extraction pattern');
  });

  it('extraction handler updates session note with summary and title', async () => {
    const sessionId = 'test-extract-def456';
    const relativePath = writeSessionNote(sessionId, { user: 'chris' });
    writeBufferEvents(sessionId);

    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    pipeline.setHandlers({
      extraction: async (itemId, itemType, sourcePath) => {
        if (itemType !== 'session') return;

        const fullPath = path.join(tmpDir, sourcePath!);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');
        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;

        // Verify placeholder title before update
        expect(body).toContain(`# Session ${sessionId}`);
        expect(body).not.toContain('[!abstract] Summary');

        // Apply LLM-generated title + narrative
        const fmEnd = fileContent.indexOf('---', 4);
        const frontmatterBlock = fileContent.slice(0, fmEnd + 3);
        const updatedBody = updateTitleAndSummary(body, 'Extraction Test Session', 'A test session for the extraction handler.');
        fs.writeFileSync(fullPath, frontmatterBlock + updatedBody, 'utf-8');

        indexNote(index, tmpDir, sourcePath!);
      },
      embedding: async () => {},
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Read updated session note
    const fullPath = path.join(tmpDir, relativePath);
    const updatedContent = fs.readFileSync(fullPath, 'utf-8');

    // Verify title was replaced
    expect(updatedContent).not.toContain(`# Session ${sessionId}`);
    expect(updatedContent).toContain('# Extraction Test Session');

    // Verify summary callout was inserted
    expect(updatedContent).toContain('[!abstract] Summary');
    expect(updatedContent).toContain('A test session for the extraction handler.');

    // Verify conversation section is preserved
    expect(updatedContent).toContain(CONVERSATION_HEADING);
    expect(updatedContent).toContain('Implement the pipeline extraction handler');
  });

  it('extraction handler registers spores in pipeline', async () => {
    const sessionId = 'test-extract-ghi789';
    const relativePath = writeSessionNote(sessionId);
    writeBufferEvents(sessionId);

    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    const registeredSpores: Array<{ id: string; path: string }> = [];

    pipeline.setHandlers({
      extraction: async (itemId, itemType, sourcePath) => {
        if (itemType !== 'session') return;

        // Simulate writing two observations
        const observations = [
          {
            type: 'gotcha' as const,
            title: 'Watch out for buffer reads',
            content: 'Buffer events must be read before they expire.',
            tags: ['buffer'],
          },
          {
            type: 'decision' as const,
            title: 'Use pipeline for extraction',
            content: 'Deferred extraction to pipeline tick for better error handling.',
            tags: ['pipeline'],
          },
        ];

        const written = writeObservationNotes(observations, itemId, vault, index, tmpDir);

        // Register spores in pipeline
        for (const note of written) {
          pipeline.register(note.id, 'spore', note.path);
          pipeline.advance(note.id, 'spore', 'capture', 'succeeded');
          registeredSpores.push({ id: note.id, path: note.path });
        }
      },
      embedding: async () => {},
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify spores were registered in pipeline
    expect(registeredSpores).toHaveLength(2);

    for (const spore of registeredSpores) {
      const statuses = pipeline.getItemStatus(spore.id, 'spore');
      expect(statuses.length).toBeGreaterThan(0);

      // capture should be succeeded
      const captureStatus = statuses.find((s) => s.stage === 'capture');
      expect(captureStatus).toBeDefined();
      expect(captureStatus!.status).toBe('succeeded');

      // embedding: spores go through embedding. Since tick() processes
      // extraction then embedding in the same cycle, and the stub embedding
      // handler succeeds immediately, embedding will be 'succeeded' here.
      const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
      expect(embeddingStatus).toBeDefined();
      expect(embeddingStatus!.status).toBe('succeeded');

      // extraction should be skipped for spores (per ITEM_STAGE_MAP)
      const extractionStatus = statuses.find((s) => s.stage === 'extraction');
      expect(extractionStatus).toBeDefined();
      expect(extractionStatus!.status).toBe('skipped');

      // consolidation: spores go through consolidation. Like embedding,
      // the stub handler succeeds in the same tick cycle.
      const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
      expect(consolidationStatus).toBeDefined();
      expect(consolidationStatus!.status).toBe('succeeded');
    }
  });

  it('extraction handler throws on LLM failure (all-or-nothing)', async () => {
    const sessionId = 'test-extract-jkl012';
    const relativePath = writeSessionNote(sessionId);
    writeBufferEvents(sessionId);

    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');

    pipeline.setHandlers({
      extraction: async (_itemId, itemType) => {
        if (itemType !== 'session') return;
        // Simulate LLM failure — throw to trigger all-or-nothing behavior
        throw new Error('LLM connection refused');
      },
      embedding: async () => {},
      consolidation: async () => {},
    });

    // Run pipeline tick — the handler throws, tick catches and classifies the error
    await pipeline.tick(10);

    // Verify extraction stage is failed
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const extractionStatus = statuses.find((s) => s.stage === 'extraction');
    expect(extractionStatus).toBeDefined();
    expect(extractionStatus!.status).toBe('failed');
    expect(extractionStatus!.error_message).toContain('LLM connection refused');

    // Verify no spore files were written (all-or-nothing)
    const sporesDir = path.join(tmpDir, 'spores');
    const sporesExist = fs.existsSync(sporesDir) && fs.readdirSync(sporesDir).length > 0;
    expect(sporesExist).toBe(false);

    // Verify session note still has placeholder title (not updated)
    const sessionContent = fs.readFileSync(path.join(tmpDir, relativePath), 'utf-8');
    expect(sessionContent).toContain(`# Session ${sessionId}`);
    expect(sessionContent).not.toContain('[!abstract] Summary');
  });

  it('updateTitleAndSummary inserts callout when none exists', () => {
    // Session body with no summary callout (capture stage)
    const body = formatSessionBody({
      title: 'Session test-123',
      narrative: '',
      sessionId: 'test-123',
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [{ prompt: 'Hello', toolCount: 0 }],
    });

    // Verify no callout initially
    expect(body).not.toContain('[!abstract] Summary');
    expect(body).toContain('# Session test-123');

    // Apply update
    const updated = updateTitleAndSummary(body, 'New Title', 'This is the narrative.');

    // Verify title was replaced
    expect(updated).toContain('# New Title');
    expect(updated).not.toContain('# Session test-123');

    // Verify callout was inserted
    expect(updated).toContain('[!abstract] Summary');
    expect(updated).toContain('This is the narrative.');

    // Verify conversation is preserved
    expect(updated).toContain(CONVERSATION_HEADING);
    expect(updated).toContain('Hello');
  });

  it('updateTitleAndSummary replaces existing callout', () => {
    // Session body with existing summary callout (from a previous extraction)
    const body = formatSessionBody({
      title: 'Old Title',
      narrative: 'Old summary text.',
      sessionId: 'test-456',
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [{ prompt: 'Hello', toolCount: 0 }],
    });

    expect(body).toContain('[!abstract] Summary');
    expect(body).toContain('Old summary text.');

    // Apply update with new title and narrative
    const updated = updateTitleAndSummary(body, 'New Title', 'New summary text.');

    expect(updated).toContain('# New Title');
    expect(updated).not.toContain('# Old Title');
    expect(updated).toContain('New summary text.');
    expect(updated).not.toContain('Old summary text.');
  });
});

/**
 * Pipeline Integration: Embedding Stage Handler
 *
 * These tests exercise the embedding handler logic that runs on pipeline tick:
 * 1. Read vault note at sourcePath
 * 2. Parse frontmatter for metadata
 * 3. Extract embeddable text (type-dependent)
 * 4. Generate embedding via provider
 * 5. Store in vectorIndex
 */
describe('Pipeline Integration: Embedding Stage Handler', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;
  let vault: VaultWriter;
  let index: MycoIndex;

  /** Mock embedding provider that returns a deterministic embedding. */
  const MOCK_DIMENSIONS = 4;
  function createMockEmbeddingProvider(shouldFail = false): EmbeddingProvider {
    return {
      name: 'mock-embedding',
      embed: async (text: string): Promise<EmbeddingResponse> => {
        if (shouldFail) {
          throw new Error('Embedding provider unavailable');
        }
        // Deterministic embedding based on text length
        const val = text.length / 1000;
        return {
          embedding: [val, val * 0.5, val * 0.25, val * 0.1],
          model: 'mock-model',
          dimensions: MOCK_DIMENSIONS,
        };
      },
      isAvailable: async () => !shouldFail,
    };
  }

  /** Mock vector index that records upserts for verification. */
  interface UpsertRecord {
    id: string;
    embedding: number[];
    metadata: Record<string, string>;
  }

  function createMockVectorIndex(): VectorIndex & { upserts: UpsertRecord[] } {
    const upserts: UpsertRecord[] = [];
    return {
      upserts,
      upsert(id: string, embedding: number[], metadata: Record<string, string> = {}) {
        upserts.push({ id, embedding, metadata });
      },
      // Stubs for interface compliance
      search: () => [],
      getEmbedding: () => null,
      has: (id: string) => upserts.some((u) => u.id === id),
      delete: () => {},
      count: () => upserts.length,
      close: () => {},
    } as unknown as VectorIndex & { upserts: UpsertRecord[] };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-embedding-integ-'));
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

  /** Helper: create a session note and register in pipeline as capture:succeeded. */
  function writeAndRegisterSession(sessionId: string, opts?: { narrative?: string; user?: string; branch?: string }): string {
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: opts?.narrative ?? '',
      sessionId,
      user: opts?.user,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:30:00Z',
      branch: opts?.branch,
      turns: [
        { prompt: 'Implement embedding handler', toolCount: 5, aiResponse: 'Done.' },
      ],
    });
    vault.writeSession({
      id: sessionId,
      user: opts?.user,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:30:00Z',
      branch: opts?.branch,
      summary,
    });
    indexNote(index, tmpDir, relativePath);
    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');
    // Skip extraction for embedding tests — advance extraction to succeeded
    pipeline.advance(sessionId, 'session', 'extraction', 'succeeded');
    return relativePath;
  }

  /** Helper: create a spore note and register in pipeline as capture:succeeded. */
  function writeAndRegisterSpore(sporeId: string, sessionId: string, opts?: { type?: string; content?: string }): string {
    const obsType = opts?.type ?? 'discovery';
    const content = opts?.content ?? 'This is a test spore observation about pipeline embedding.';
    const relativePath = vault.writeSpore({
      id: sporeId,
      observation_type: obsType,
      session: sessionId,
      tags: ['test'],
      content: `# Test Spore\n\n${content}`,
    });
    indexNote(index, tmpDir, relativePath);
    pipeline.register(sporeId, 'spore', relativePath);
    pipeline.advance(sporeId, 'spore', 'capture', 'succeeded');
    // Spores skip extraction per ITEM_STAGE_MAP
    return relativePath;
  }

  it('embedding handler stores vector in vectorIndex on success (session)', async () => {
    const sessionId = 'test-embed-session-001';
    const relativePath = writeAndRegisterSession(sessionId, {
      narrative: 'Implemented the embedding stage handler for the pipeline.',
      user: 'chris',
      branch: 'feat/embedding',
    });

    const mockProvider = createMockEmbeddingProvider();
    const mockVectorIndex = createMockVectorIndex();

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async (itemId, itemType, sourcePath) => {
        if (!sourcePath) throw new Error(`No source path for ${itemType}/${itemId}`);

        const fullPath = path.join(tmpDir, sourcePath);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');

        // Parse frontmatter
        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter = fmMatch ? YAML.parse(fmMatch[1]) as Record<string, unknown> : {};
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;

        // Extract embeddable text for session
        let embeddableText: string;
        if (itemType === 'session') {
          const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
          const summary = typeof frontmatter.summary === 'string' ? frontmatter.summary : '';
          const calloutMatch = body.match(/> \[!abstract\] Summary\n((?:> .*\n?)*)/);
          const narrative = calloutMatch ? calloutMatch[1].replace(/^> /gm, '').trim() : '';
          embeddableText = `${title}\n${narrative || summary}`.trim();
        } else {
          const titleMatch = body.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1] : '';
          embeddableText = `${title}\n${body}`.trim();
        }

        if (!embeddableText) return;

        const result = await generateEmbedding(mockProvider, embeddableText.slice(0, EMBEDDING_INPUT_LIMIT));
        mockVectorIndex.upsert(itemId, result.embedding, {
          type: itemType,
          file_path: sourcePath,
          session_id: typeof frontmatter.id === 'string' && itemType === 'session' ? frontmatter.id : '',
        });
      },
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify embedding was stored
    expect(mockVectorIndex.upserts).toHaveLength(1);
    expect(mockVectorIndex.upserts[0].id).toBe(sessionId);
    expect(mockVectorIndex.upserts[0].embedding).toHaveLength(MOCK_DIMENSIONS);
    expect(mockVectorIndex.upserts[0].metadata.type).toBe('session');
    expect(mockVectorIndex.upserts[0].metadata.file_path).toBe(relativePath);

    // Verify pipeline advanced embedding to succeeded
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
    expect(embeddingStatus).toBeDefined();
    expect(embeddingStatus!.status).toBe('succeeded');
  });

  it('embedding handler stores vector in vectorIndex on success (spore)', async () => {
    const sessionId = 'test-embed-spore-parent';
    const sporeId = `discovery-${sessionId.slice(-6)}-${Date.now()}`;
    const relativePath = writeAndRegisterSpore(sporeId, sessionId, {
      content: 'Pipeline embedding handler reads vault notes and generates embeddings.',
    });

    const mockProvider = createMockEmbeddingProvider();
    const mockVectorIndex = createMockVectorIndex();

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async (itemId, itemType, sourcePath) => {
        if (!sourcePath) throw new Error(`No source path for ${itemType}/${itemId}`);

        const fullPath = path.join(tmpDir, sourcePath);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');

        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter = fmMatch ? YAML.parse(fmMatch[1]) as Record<string, unknown> : {};
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;

        const titleMatch = body.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : '';
        const embeddableText = `${title}\n${body}`.trim();

        if (!embeddableText) return;

        const result = await generateEmbedding(mockProvider, embeddableText.slice(0, EMBEDDING_INPUT_LIMIT));
        mockVectorIndex.upsert(itemId, result.embedding, {
          type: itemType,
          file_path: sourcePath,
          session_id: typeof frontmatter.session === 'string' ? frontmatter.session : '',
        });
      },
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify embedding was stored for the spore
    expect(mockVectorIndex.upserts).toHaveLength(1);
    expect(mockVectorIndex.upserts[0].id).toBe(sporeId);
    expect(mockVectorIndex.upserts[0].embedding).toHaveLength(MOCK_DIMENSIONS);
    expect(mockVectorIndex.upserts[0].metadata.type).toBe('spore');
    expect(mockVectorIndex.upserts[0].metadata.file_path).toBe(relativePath);
    expect(mockVectorIndex.upserts[0].metadata.session_id).toBe(sessionId);

    // Verify pipeline advanced embedding to succeeded
    const statuses = pipeline.getItemStatus(sporeId, 'spore');
    const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
    expect(embeddingStatus).toBeDefined();
    expect(embeddingStatus!.status).toBe('succeeded');
  });

  it('embedding handler throws on provider failure', async () => {
    const sessionId = 'test-embed-fail-001';
    writeAndRegisterSession(sessionId);

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async (itemId, itemType, sourcePath) => {
        if (!sourcePath) throw new Error(`No source path for ${itemType}/${itemId}`);

        const fullPath = path.join(tmpDir, sourcePath);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');

        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;

        const embeddableText = body.trim();
        if (!embeddableText) return;

        // This provider will throw
        const failingProvider = createMockEmbeddingProvider(true);
        await generateEmbedding(failingProvider, embeddableText.slice(0, EMBEDDING_INPUT_LIMIT));
      },
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify embedding stage is failed
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
    expect(embeddingStatus).toBeDefined();
    expect(embeddingStatus!.status).toBe('failed');
    expect(embeddingStatus!.error_message).toContain('Embedding provider unavailable');
  });

  it('embedding handler handles missing sourcePath gracefully', async () => {
    const sessionId = 'test-embed-no-path-001';
    // Register with a path that doesn't exist on disk
    const fakePath = 'sessions/2026-03-21/session-nonexistent.md';
    pipeline.register(sessionId, 'session', fakePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');
    pipeline.advance(sessionId, 'session', 'extraction', 'succeeded');

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async (itemId, itemType, sourcePath) => {
        if (!sourcePath) throw new Error(`No source path for ${itemType}/${itemId}`);

        const fullPath = path.join(tmpDir, sourcePath);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Vault note not found: ${sourcePath}`);
        }
      },
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify embedding stage is failed
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const embeddingStatus = statuses.find((s) => s.stage === 'embedding');
    expect(embeddingStatus).toBeDefined();
    expect(embeddingStatus!.status).toBe('failed');
    expect(embeddingStatus!.error_message).toContain('Vault note not found');
  });

  it('embedding handler extracts narrative from session abstract callout', async () => {
    const sessionId = 'test-embed-narrative-001';
    // Write a session with a narrative (which creates an abstract callout)
    writeAndRegisterSession(sessionId, {
      narrative: 'This session implemented the embedding stage handler for the processing pipeline.',
    });

    const embeddedTexts: string[] = [];
    const mockProvider: EmbeddingProvider = {
      name: 'capture-mock',
      embed: async (text: string) => {
        embeddedTexts.push(text);
        return { embedding: [0.1, 0.2, 0.3, 0.4], model: 'mock', dimensions: 4 };
      },
      isAvailable: async () => true,
    };
    const mockVectorIndex = createMockVectorIndex();

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async (itemId, itemType, sourcePath) => {
        if (!sourcePath) return;
        const fullPath = path.join(tmpDir, sourcePath);
        const fileContent = fs.readFileSync(fullPath, 'utf-8');
        const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter = fmMatch ? YAML.parse(fmMatch[1]) as Record<string, unknown> : {};
        const body = fmMatch ? fileContent.slice(fmMatch[0].length) : fileContent;

        let embeddableText: string;
        if (itemType === 'session') {
          const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
          const calloutMatch = body.match(/> \[!abstract\] Summary\n((?:> .*\n?)*)/);
          const narrative = calloutMatch ? calloutMatch[1].replace(/^> /gm, '').trim() : '';
          embeddableText = `${title}\n${narrative}`.trim();
        } else {
          embeddableText = body.trim();
        }

        if (!embeddableText) return;

        const result = await generateEmbedding(mockProvider, embeddableText.slice(0, EMBEDDING_INPUT_LIMIT));
        mockVectorIndex.upsert(itemId, result.embedding, { type: itemType, file_path: sourcePath });
      },
      consolidation: async () => {},
    });

    await pipeline.tick(10);

    // Verify the narrative was extracted and embedded
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('embedding stage handler');
    expect(mockVectorIndex.upserts).toHaveLength(1);
  });
});
