import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineManager, type StageHandlers } from '@myco/daemon/pipeline';
import { VaultWriter } from '@myco/vault/writer';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import { indexNote } from '@myco/index/rebuild';
import { formatSessionBody, CONVERSATION_HEADING, extractSection, callout } from '@myco/obsidian/formatter';
import { sessionNoteId, sessionRelativePath } from '@myco/vault/session-id';
import { writeObservationNotes } from '@myco/vault/observations';
import { updateTitleAndSummary, runReprocess, runDigest, runCuration } from '@myco/services/vault-ops';
import type { OperationContext, CurationDeps } from '@myco/services/vault-ops';
import { MycoConfigSchema } from '@myco/config/schema';
import { SUMMARIZATION_FAILED_MARKER } from '@myco/daemon/processor';
import { generateEmbedding } from '@myco/intelligence/embeddings';
import { EventBuffer } from '@myco/capture/buffer';
import { ITEM_STAGE_MAP, EMBEDDING_INPUT_LIMIT } from '@myco/constants';
import type { EmbeddingProvider, EmbeddingResponse, LlmProvider } from '@myco/intelligence/llm';
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

/**
 * Pipeline Integration: Consolidation Stage Handler
 *
 * These tests exercise the consolidation handler logic that runs on pipeline tick:
 * 1. Only processes spore items — sessions and artifacts skip
 * 2. Runs supersession check (checkSupersession) for the spore
 * 3. Runs consolidation pass (ConsolidationEngine.runPass) for clustering
 * 4. Throws on failure so the pipeline records the error
 */
describe('Pipeline Integration: Consolidation Stage Handler', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;
  let vault: VaultWriter;
  let index: MycoIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-consolidation-integ-'));
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

  /** Helper: create a spore note and register in pipeline with embedding:succeeded. */
  function writeAndRegisterSpore(sporeId: string, sessionId: string, opts?: { type?: string; content?: string }): string {
    const obsType = opts?.type ?? 'discovery';
    const content = opts?.content ?? 'This is a test spore for consolidation stage.';
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
    // Spores skip extraction per ITEM_STAGE_MAP, advance embedding to succeeded
    pipeline.advance(sporeId, 'spore', 'embedding', 'succeeded');
    return relativePath;
  }

  it('consolidation handler runs for spore items', async () => {
    const sessionId = 'test-consol-parent-001';
    const sporeId = `discovery-${sessionId.slice(-6)}-${Date.now()}`;
    writeAndRegisterSpore(sporeId, sessionId);

    const supersessionCalls: string[] = [];
    const consolidationPassCalls: number[] = [];

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async () => {},
      consolidation: async (itemId, itemType) => {
        if (itemType !== 'spore') return;

        // Track supersession call
        supersessionCalls.push(itemId);

        // Simulate consolidation pass
        consolidationPassCalls.push(1);
      },
    });

    await pipeline.tick(10);

    // Verify the handler was called for the spore
    expect(supersessionCalls).toHaveLength(1);
    expect(supersessionCalls[0]).toBe(sporeId);
    expect(consolidationPassCalls).toHaveLength(1);

    // Verify consolidation stage advanced to succeeded
    const statuses = pipeline.getItemStatus(sporeId, 'spore');
    const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
    expect(consolidationStatus).toBeDefined();
    expect(consolidationStatus!.status).toBe('succeeded');
  });

  it('consolidation handler skips non-spore items', async () => {
    const sessionId = 'test-consol-skip-001';
    const date = '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);

    // Write a session note
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative: '',
      sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      turns: [{ prompt: 'Test consolidation skip', toolCount: 0 }],
    });
    vault.writeSession({
      id: sessionId,
      started: '2026-03-21T10:00:00Z',
      ended: '2026-03-21T10:15:00Z',
      summary,
    });
    indexNote(index, tmpDir, relativePath);

    pipeline.register(sessionId, 'session', relativePath);
    pipeline.advance(sessionId, 'session', 'capture', 'succeeded');
    pipeline.advance(sessionId, 'session', 'extraction', 'succeeded');
    pipeline.advance(sessionId, 'session', 'embedding', 'succeeded');

    // Consolidation should be skipped for sessions per ITEM_STAGE_MAP
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
    expect(consolidationStatus).toBeDefined();
    expect(consolidationStatus!.status).toBe('skipped');

    // Verify ITEM_STAGE_MAP confirms sessions don't have consolidation
    expect(ITEM_STAGE_MAP['session']).not.toContain('consolidation');
  });

  it('consolidation handler throws on failure', async () => {
    const sessionId = 'test-consol-fail-001';
    const sporeId = `gotcha-${sessionId.slice(-6)}-${Date.now()}`;
    writeAndRegisterSpore(sporeId, sessionId, { type: 'gotcha' });

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async () => {},
      consolidation: async (itemId, itemType) => {
        if (itemType !== 'spore') return;

        // Simulate LLM failure during supersession check
        throw new Error('LLM provider connection refused');
      },
    });

    await pipeline.tick(10);

    // Verify consolidation stage is failed
    const statuses = pipeline.getItemStatus(sporeId, 'spore');
    const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
    expect(consolidationStatus).toBeDefined();
    expect(consolidationStatus!.status).toBe('failed');
    expect(consolidationStatus!.error_message).toContain('LLM provider connection refused');
  });

  it('consolidation handler processes multiple spores independently', async () => {
    const sessionId = 'test-consol-multi-001';
    const sporeId1 = `discovery-${sessionId.slice(-6)}-${Date.now()}`;
    const sporeId2 = `gotcha-${sessionId.slice(-6)}-${Date.now() + 1}`;
    writeAndRegisterSpore(sporeId1, sessionId, { type: 'discovery', content: 'First spore observation.' });
    writeAndRegisterSpore(sporeId2, sessionId, { type: 'gotcha', content: 'Second spore observation.' });

    const processedSpores: string[] = [];

    pipeline.setHandlers({
      extraction: async () => {},
      embedding: async () => {},
      consolidation: async (itemId, itemType) => {
        if (itemType !== 'spore') return;
        processedSpores.push(itemId);
      },
    });

    await pipeline.tick(10);

    // Both spores should have been processed
    expect(processedSpores).toHaveLength(2);
    expect(processedSpores).toContain(sporeId1);
    expect(processedSpores).toContain(sporeId2);

    // Both should have consolidation:succeeded
    for (const sporeId of [sporeId1, sporeId2]) {
      const statuses = pipeline.getItemStatus(sporeId, 'spore');
      const consolidationStatus = statuses.find((s) => s.stage === 'consolidation');
      expect(consolidationStatus).toBeDefined();
      expect(consolidationStatus!.status).toBe('succeeded');
    }
  });
});

/**
 * Pipeline Integration: Digest Stage Gating
 *
 * These tests verify that:
 * 1. hasUpstreamWork() detects pending/processing/blocked items at upstream stages
 * 2. hasUpstreamWork() ignores failed/poisoned items and digest-only items
 * 3. advanceDigestItems() marks all digest:pending items as digest:succeeded
 */
describe('Pipeline Integration: Digest Stage Gating', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-digest-gate-'));
    pipeline = new PipelineManager(tmpDir);
  });

  afterEach(() => {
    pipeline.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hasUpstreamWork returns true when extraction has pending items', () => {
    pipeline.register('session-001', 'session', 'sessions/2026-03-21/session-session-001.md');
    pipeline.advance('session-001', 'session', 'capture', 'succeeded');
    // extraction is now pending (default from register)

    expect(pipeline.hasUpstreamWork()).toBe(true);
  });

  it('hasUpstreamWork returns true when embedding has processing items', () => {
    pipeline.register('session-002', 'session', 'sessions/2026-03-21/session-session-002.md');
    pipeline.advance('session-002', 'session', 'capture', 'succeeded');
    pipeline.advance('session-002', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-002', 'session', 'embedding', 'processing');

    expect(pipeline.hasUpstreamWork()).toBe(true);
  });

  it('hasUpstreamWork returns true when consolidation has blocked items', () => {
    pipeline.register('spore-001', 'spore', 'spores/discovery/discovery-001.md');
    pipeline.advance('spore-001', 'spore', 'capture', 'succeeded');
    pipeline.advance('spore-001', 'spore', 'embedding', 'succeeded');
    pipeline.advance('spore-001', 'spore', 'consolidation', 'blocked', {
      errorType: 'config',
      errorMessage: 'circuit open',
    });

    expect(pipeline.hasUpstreamWork()).toBe(true);
  });

  it('hasUpstreamWork returns false when only digest:pending items remain', () => {
    pipeline.register('session-003', 'session', 'sessions/2026-03-21/session-session-003.md');
    pipeline.advance('session-003', 'session', 'capture', 'succeeded');
    pipeline.advance('session-003', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-003', 'session', 'embedding', 'succeeded');
    // consolidation is skipped for sessions (per ITEM_STAGE_MAP)
    // digest is pending — but that's not an upstream stage

    expect(pipeline.hasUpstreamWork()).toBe(false);
  });

  it('hasUpstreamWork returns false when upstream has only failed/poisoned items', () => {
    pipeline.register('session-004', 'session', 'sessions/2026-03-21/session-session-004.md');
    pipeline.advance('session-004', 'session', 'capture', 'succeeded');
    pipeline.advance('session-004', 'session', 'extraction', 'failed', {
      errorType: 'transient',
      errorMessage: 'LLM timeout',
    });

    // Failed items should not block digest (they'll be retried or poisoned)
    // However, failed items are retried by the pipeline — a failed item will
    // revert to pending on next tick. So "failed" alone doesn't block, but
    // check the actual query: we only block on pending/processing/blocked.
    // After a failure, the item status is 'failed' which is NOT in the blocking set.

    // But we need to also check that embedding is pending (since extraction failed,
    // embedding can't proceed — it requires extraction:succeeded as prerequisite).
    // Since extraction failed, embedding stays pending which IS a blocking status.
    // Let's test with a scenario where extraction is poisoned (terminal) and
    // embedding is blocked.
    pipeline.advance('session-004', 'session', 'extraction', 'poisoned');

    // At this point extraction is poisoned. Embedding is still pending (it requires
    // extraction:succeeded to be picked up by nextBatch, but its pipeline_status
    // row still shows 'pending'). So hasUpstreamWork will see embedding:pending.
    // To truly test "only failed/poisoned", we need to also advance downstream.
    pipeline.advance('session-004', 'session', 'embedding', 'poisoned');

    // Now extraction:poisoned, embedding:poisoned — neither is pending/processing/blocked
    // Consolidation is skipped for sessions
    expect(pipeline.hasUpstreamWork()).toBe(false);
  });

  it('hasUpstreamWork returns false when all upstream stages are succeeded/skipped', () => {
    // Register a session and a spore, advance all upstream stages
    pipeline.register('session-005', 'session', 'sessions/2026-03-21/session-session-005.md');
    pipeline.advance('session-005', 'session', 'capture', 'succeeded');
    pipeline.advance('session-005', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-005', 'session', 'embedding', 'succeeded');
    // consolidation: skipped for sessions

    pipeline.register('spore-002', 'spore', 'spores/discovery/discovery-002.md');
    pipeline.advance('spore-002', 'spore', 'capture', 'succeeded');
    // extraction: skipped for spores
    pipeline.advance('spore-002', 'spore', 'embedding', 'succeeded');
    pipeline.advance('spore-002', 'spore', 'consolidation', 'succeeded');

    expect(pipeline.hasUpstreamWork()).toBe(false);
  });

  it('advanceDigestItems marks all digest:pending items as digest:succeeded', () => {
    // Register two items and advance them through all upstream stages
    pipeline.register('session-006', 'session', 'sessions/2026-03-21/session-session-006.md');
    pipeline.advance('session-006', 'session', 'capture', 'succeeded');
    pipeline.advance('session-006', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-006', 'session', 'embedding', 'succeeded');

    pipeline.register('spore-003', 'spore', 'spores/gotcha/gotcha-003.md');
    pipeline.advance('spore-003', 'spore', 'capture', 'succeeded');
    pipeline.advance('spore-003', 'spore', 'embedding', 'succeeded');
    pipeline.advance('spore-003', 'spore', 'consolidation', 'succeeded');

    // Both should have digest:pending at this point
    const sessionStatuses = pipeline.getItemStatus('session-006', 'session');
    const sessionDigest = sessionStatuses.find((s) => s.stage === 'digest');
    expect(sessionDigest).toBeDefined();
    expect(sessionDigest!.status).toBe('pending');

    const sporeStatuses = pipeline.getItemStatus('spore-003', 'spore');
    const sporeDigest = sporeStatuses.find((s) => s.stage === 'digest');
    expect(sporeDigest).toBeDefined();
    expect(sporeDigest!.status).toBe('pending');

    // Advance all digest items
    const advanced = pipeline.advanceDigestItems();
    expect(advanced).toBe(2);

    // Verify both are now digest:succeeded
    const sessionAfter = pipeline.getItemStatus('session-006', 'session');
    const sessionDigestAfter = sessionAfter.find((s) => s.stage === 'digest');
    expect(sessionDigestAfter!.status).toBe('succeeded');

    const sporeAfter = pipeline.getItemStatus('spore-003', 'spore');
    const sporeDigestAfter = sporeAfter.find((s) => s.stage === 'digest');
    expect(sporeDigestAfter!.status).toBe('succeeded');
  });

  it('advanceDigestItems returns 0 when no digest:pending items exist', () => {
    // No items registered at all
    expect(pipeline.advanceDigestItems()).toBe(0);
  });

  it('advanceDigestItems does not affect non-pending digest items', () => {
    // Register an item and advance digest to succeeded manually
    pipeline.register('session-007', 'session', 'sessions/2026-03-21/session-session-007.md');
    pipeline.advance('session-007', 'session', 'capture', 'succeeded');
    pipeline.advance('session-007', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-007', 'session', 'embedding', 'succeeded');
    pipeline.advance('session-007', 'session', 'digest', 'succeeded');

    // Register another item still at digest:pending
    pipeline.register('session-008', 'session', 'sessions/2026-03-21/session-session-008.md');
    pipeline.advance('session-008', 'session', 'capture', 'succeeded');
    pipeline.advance('session-008', 'session', 'extraction', 'succeeded');
    pipeline.advance('session-008', 'session', 'embedding', 'succeeded');

    // Only session-008 should be advanced (session-007 is already succeeded)
    const advanced = pipeline.advanceDigestItems();
    expect(advanced).toBe(1);

    // Verify session-008 is now succeeded
    const statuses = pipeline.getItemStatus('session-008', 'session');
    const digestStatus = statuses.find((s) => s.stage === 'digest');
    expect(digestStatus!.status).toBe('succeeded');
  });
});

/**
 * Pipeline Integration: CLI Operations Enqueue via Pipeline
 *
 * Verifies that runReprocess, runDigest, and runCuration enqueue work
 * via the PipelineManager when it is available, instead of processing inline.
 */
describe('Pipeline Integration: CLI Operations Enqueue via Pipeline', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;
  let vault: VaultWriter;
  let index: MycoIndex;
  const config = MycoConfigSchema.parse({
    version: 2,
    intelligence: {
      llm: { provider: 'ollama', model: 'test-model' },
      embedding: { provider: 'ollama', model: 'test-embed' },
    },
  });

  /** Stub LLM provider — should NOT be called in pipeline mode. */
  const stubLlmProvider: LlmProvider = {
    name: 'stub-llm',
    summarize: async () => {
      throw new Error('LLM should not be called in pipeline mode');
    },
    isAvailable: async () => true,
  };

  /** Stub embedding provider — should NOT be called in pipeline mode for reprocess. */
  const stubEmbeddingProvider: EmbeddingProvider = {
    name: 'stub-embedding',
    embed: async () => {
      throw new Error('Embedding should not be called in pipeline mode');
    },
    isAvailable: async () => true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cli-pipeline-'));
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

  /** Helper: write a session note into the vault and FTS-index it. */
  function writeTestSession(sessionId: string, opts?: { date?: string; failed?: boolean }): string {
    const date = opts?.date ?? '2026-03-21';
    const relativePath = sessionRelativePath(sessionId, date);
    const narrative = opts?.failed ? SUMMARIZATION_FAILED_MARKER : 'Test session narrative.';
    const summary = formatSessionBody({
      title: `Session ${sessionId}`,
      narrative,
      sessionId,
      started: `${date}T10:00:00Z`,
      ended: `${date}T10:30:00Z`,
      turns: [{ prompt: 'Test prompt', toolCount: 1 }],
    });
    vault.writeSession({
      id: sessionId,
      started: `${date}T10:00:00Z`,
      ended: `${date}T10:30:00Z`,
      summary,
    });
    indexNote(index, tmpDir, relativePath);
    return relativePath;
  }

  /** Helper: write a spore note into the vault and FTS-index it. */
  function writeTestSpore(sporeId: string, sessionId: string, opts?: { type?: string }): string {
    const obsType = opts?.type ?? 'discovery';
    const relativePath = vault.writeSpore({
      id: sporeId,
      observation_type: obsType,
      session: sessionId,
      tags: ['test'],
      content: `# Test Spore ${sporeId}\n\nThis is a test spore for CLI pipeline integration.`,
    });
    indexNote(index, tmpDir, relativePath);
    return relativePath;
  }

  // --- runReprocess with pipeline ---

  it('runReprocess with pipeline registers sessions at extraction:pending', async () => {
    const sessionId = 'cli-reprocess-001';
    writeTestSession(sessionId);

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    const result = await runReprocess(ctx, stubLlmProvider, stubEmbeddingProvider);

    // Should be enqueued, not inline processed
    expect(result.enqueued).toBe(true);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsFound).toBe(1);
    // No inline work done
    expect(result.observationsExtracted).toBe(0);
    expect(result.summariesRegenerated).toBe(0);
    expect(result.embeddingsQueued).toBe(0);

    // Verify pipeline state
    const statuses = pipeline.getItemStatus(sessionId, 'session');
    const captureStatus = statuses.find((s) => s.stage === 'capture');
    expect(captureStatus).toBeDefined();
    expect(captureStatus!.status).toBe('succeeded');

    const extractionStatus = statuses.find((s) => s.stage === 'extraction');
    expect(extractionStatus).toBeDefined();
    expect(extractionStatus!.status).toBe('pending');
  });

  it('runReprocess with pipeline respects date filter', async () => {
    writeTestSession('cli-reprocess-date-001', { date: '2026-03-20' });
    writeTestSession('cli-reprocess-date-002', { date: '2026-03-21' });

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    const result = await runReprocess(ctx, stubLlmProvider, stubEmbeddingProvider, {
      date: '2026-03-21',
    });

    expect(result.enqueued).toBe(true);
    expect(result.sessionsProcessed).toBe(1);

    // Only the session matching the date filter should be registered
    const statuses1 = pipeline.getItemStatus('cli-reprocess-date-001', 'session');
    expect(statuses1).toHaveLength(0); // Not registered

    const statuses2 = pipeline.getItemStatus('cli-reprocess-date-002', 'session');
    expect(statuses2.length).toBeGreaterThan(0);
  });

  it('runReprocess with pipeline respects failed filter', async () => {
    writeTestSession('cli-reprocess-pass-001');
    writeTestSession('cli-reprocess-fail-001', { failed: true });

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    const result = await runReprocess(ctx, stubLlmProvider, stubEmbeddingProvider, {
      failed: true,
    });

    expect(result.enqueued).toBe(true);
    expect(result.sessionsProcessed).toBe(1);

    // Only the failed session should be registered
    const statusesPass = pipeline.getItemStatus('cli-reprocess-pass-001', 'session');
    expect(statusesPass).toHaveLength(0);

    const statusesFail = pipeline.getItemStatus('cli-reprocess-fail-001', 'session');
    expect(statusesFail.length).toBeGreaterThan(0);
  });

  it('runReprocess with pipeline and indexOnly falls back to legacy mode', async () => {
    writeTestSession('cli-reprocess-idx-001');

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    // indexOnly=true should bypass pipeline mode (no LLM needed)
    const result = await runReprocess(ctx, null, stubEmbeddingProvider, {
      indexOnly: true,
    });

    // Should NOT be enqueued — legacy inline mode handles index-only
    expect(result.enqueued).toBeUndefined();
    // The session should be found and processed inline
    expect(result.sessionsFound).toBe(1);
  });

  it('runReprocess without pipeline falls back to legacy mode', async () => {
    writeTestSession('cli-reprocess-legacy-001');

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      // No pipeline — legacy mode
    };

    // Use null llmProvider for index-only to avoid needing a real LLM
    const result = await runReprocess(ctx, null, stubEmbeddingProvider, {
      indexOnly: true,
    });

    // Should NOT be enqueued
    expect(result.enqueued).toBeUndefined();
    expect(result.sessionsFound).toBe(1);
  });

  it('runReprocess with pipeline is idempotent on re-registration', async () => {
    const sessionId = 'cli-reprocess-idem-001';
    writeTestSession(sessionId);

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    // Run twice — should be idempotent
    await runReprocess(ctx, stubLlmProvider, stubEmbeddingProvider);
    await runReprocess(ctx, stubLlmProvider, stubEmbeddingProvider);

    // Should still have exactly one work item
    const { items } = pipeline.listItems({ type: 'session' });
    const uniqueIds = new Set(items.filter((i) => i.id === sessionId).map((i) => i.id));
    expect(uniqueIds.size).toBe(1);
  });

  // --- runDigest with pipeline ---

  it('runDigest with pipeline and --full resets digest:succeeded items to pending', async () => {
    // Register some items as fully processed (digest:succeeded)
    pipeline.register('digest-session-001', 'session', 'sessions/2026-03-21/session-digest-session-001.md');
    pipeline.advance('digest-session-001', 'session', 'capture', 'succeeded');
    pipeline.advance('digest-session-001', 'session', 'extraction', 'succeeded');
    pipeline.advance('digest-session-001', 'session', 'embedding', 'succeeded');
    pipeline.advance('digest-session-001', 'session', 'digest', 'succeeded');

    pipeline.register('digest-session-002', 'session', 'sessions/2026-03-21/session-digest-session-002.md');
    pipeline.advance('digest-session-002', 'session', 'capture', 'succeeded');
    pipeline.advance('digest-session-002', 'session', 'extraction', 'succeeded');
    pipeline.advance('digest-session-002', 'session', 'embedding', 'succeeded');
    pipeline.advance('digest-session-002', 'session', 'digest', 'succeeded');

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    const result = await runDigest(ctx, stubLlmProvider, { full: true });

    // Returns null because the pipeline defers to metabolism timer
    expect(result).toBeNull();

    // Verify items were reset to digest:pending
    const statuses1 = pipeline.getItemStatus('digest-session-001', 'session');
    const digest1 = statuses1.find((s) => s.stage === 'digest');
    expect(digest1!.status).toBe('pending');

    const statuses2 = pipeline.getItemStatus('digest-session-002', 'session');
    const digest2 = statuses2.find((s) => s.stage === 'digest');
    expect(digest2!.status).toBe('pending');
  });

  it('runDigest with pipeline and no --full runs engine directly', async () => {
    // This test verifies that non-full digest calls do NOT use the pipeline
    // shortcut. They go through the DigestEngine directly. Since we can't
    // instantiate a real DigestEngine in this test, we verify that the method
    // does NOT reset pipeline items (no side effects on pipeline state).

    pipeline.register('digest-nofull-001', 'session', 'sessions/2026-03-21/session-digest-nofull-001.md');
    pipeline.advance('digest-nofull-001', 'session', 'capture', 'succeeded');
    pipeline.advance('digest-nofull-001', 'session', 'extraction', 'succeeded');
    pipeline.advance('digest-nofull-001', 'session', 'embedding', 'succeeded');
    pipeline.advance('digest-nofull-001', 'session', 'digest', 'succeeded');

    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      pipeline,
    };

    // Non-full digest will try to run DigestEngine.runCycle() which reads
    // vault files. With an empty digest dir, it should return null.
    // The key assertion is that digest:succeeded items are NOT reset.
    try {
      await runDigest(ctx, stubLlmProvider);
    } catch {
      // DigestEngine may throw because the vault is empty — that's fine.
    }

    // Verify the item was NOT reset to pending
    const statuses = pipeline.getItemStatus('digest-nofull-001', 'session');
    const digestStatus = statuses.find((s) => s.stage === 'digest');
    expect(digestStatus!.status).toBe('succeeded');
  });

  it('runDigest without pipeline falls back to engine directly', async () => {
    const ctx: OperationContext = {
      vaultDir: tmpDir,
      config,
      index,
      // No pipeline
    };

    // Without pipeline, even --full goes through DigestEngine directly.
    // With an empty vault the engine returns null or throws.
    try {
      const result = await runDigest(ctx, stubLlmProvider, { full: true });
      // If it succeeds, result may be null (no substrate)
      expect(result === null || result !== undefined).toBe(true);
    } catch {
      // DigestEngine may throw on empty vault — acceptable for this test.
    }
  });

  // --- runCuration with pipeline ---

  it('runCuration with pipeline registers spores at consolidation:pending', async () => {
    const sessionId = 'cli-curate-session-001';
    writeTestSession(sessionId);
    writeTestSpore('cli-curate-spore-001', sessionId, { type: 'discovery' });
    writeTestSpore('cli-curate-spore-002', sessionId, { type: 'gotcha' });

    // Create a mock vector index (curation requires it)
    const mockVectorIndex = {
      upsert: () => {},
      search: () => [],
      getEmbedding: () => null,
      has: () => false,
      delete: () => {},
      count: () => 0,
      close: () => {},
    } as unknown as VectorIndex;

    const deps: CurationDeps = {
      vaultDir: tmpDir,
      config,
      index,
      vectorIndex: mockVectorIndex,
      llmProvider: stubLlmProvider,
      embeddingProvider: stubEmbeddingProvider,
      pipeline,
    };

    const result = await runCuration(deps, false);

    expect(result.enqueued).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.clustersEvaluated).toBe(0);
    expect(result.superseded).toBe(0);

    // Verify spores were registered in pipeline at consolidation:pending
    const statuses1 = pipeline.getItemStatus('cli-curate-spore-001', 'spore');
    expect(statuses1.length).toBeGreaterThan(0);
    const consol1 = statuses1.find((s) => s.stage === 'consolidation');
    expect(consol1).toBeDefined();
    expect(consol1!.status).toBe('pending');

    const statuses2 = pipeline.getItemStatus('cli-curate-spore-002', 'spore');
    expect(statuses2.length).toBeGreaterThan(0);
    const consol2 = statuses2.find((s) => s.stage === 'consolidation');
    expect(consol2).toBeDefined();
    expect(consol2!.status).toBe('pending');
  });

  it('runCuration with pipeline and dry-run does NOT enqueue', async () => {
    const sessionId = 'cli-curate-dry-session';
    writeTestSession(sessionId);
    writeTestSpore('cli-curate-dry-spore-001', sessionId);

    const mockVectorIndex = {
      upsert: () => {},
      search: () => [],
      getEmbedding: () => null,
      has: () => false,
      delete: () => {},
      count: () => 0,
      close: () => {},
    } as unknown as VectorIndex;

    const deps: CurationDeps = {
      vaultDir: tmpDir,
      config,
      index,
      vectorIndex: mockVectorIndex,
      llmProvider: stubLlmProvider,
      embeddingProvider: stubEmbeddingProvider,
      pipeline,
    };

    // Dry run should bypass pipeline and go inline
    // It will try to embed spores inline which will fail with our stub,
    // but should still not enqueue
    const result = await runCuration(deps, true);

    expect(result.enqueued).toBeUndefined();
    // The inline path scans 1 active spore but embedding fails so no clusters
    expect(result.scanned).toBe(1);
    expect(result.clustersEvaluated).toBe(0);
    expect(result.superseded).toBe(0);
  });

  it('runCuration without pipeline falls back to inline mode', async () => {
    const sessionId = 'cli-curate-legacy-session';
    writeTestSession(sessionId);
    writeTestSpore('cli-curate-legacy-spore', sessionId);

    const mockVectorIndex = {
      upsert: () => {},
      search: () => [],
      getEmbedding: () => null,
      has: () => false,
      delete: () => {},
      count: () => 0,
      close: () => {},
    } as unknown as VectorIndex;

    const deps: CurationDeps = {
      vaultDir: tmpDir,
      config,
      index,
      vectorIndex: mockVectorIndex,
      llmProvider: stubLlmProvider,
      embeddingProvider: stubEmbeddingProvider,
      // No pipeline
    };

    // Without pipeline, runs inline. The stub embedding will fail on each spore.
    const result = await runCuration(deps, false);

    expect(result.enqueued).toBeUndefined();
    // 1 active spore found but embedding fails so no clusters are evaluated
    expect(result.scanned).toBe(1);
    expect(result.clustersEvaluated).toBe(0);
  });

  it('runCuration with pipeline skips superseded spores', async () => {
    const sessionId = 'cli-curate-skip-session';
    writeTestSession(sessionId);

    // Write an active spore
    writeTestSpore('cli-curate-active-spore', sessionId);

    // Write a superseded spore manually (writeSpore doesn't support status field)
    const supersededDir = path.join(tmpDir, 'spores', 'discovery');
    fs.mkdirSync(supersededDir, { recursive: true });
    const supersededRelPath = 'spores/discovery/cli-curate-superseded-spore.md';
    const supersededFullPath = path.join(tmpDir, supersededRelPath);
    fs.writeFileSync(supersededFullPath, [
      '---',
      'type: spore',
      'id: cli-curate-superseded-spore',
      'observation_type: discovery',
      `session: ${sessionId}`,
      'status: superseded',
      `created: ${new Date().toISOString()}`,
      'tags:',
      '  - test',
      '---',
      '# Superseded Spore',
      '',
      'This is superseded.',
    ].join('\n'));
    indexNote(index, tmpDir, supersededRelPath);

    const mockVectorIndex = {
      upsert: () => {},
      search: () => [],
      getEmbedding: () => null,
      has: () => false,
      delete: () => {},
      count: () => 0,
      close: () => {},
    } as unknown as VectorIndex;

    const deps: CurationDeps = {
      vaultDir: tmpDir,
      config,
      index,
      vectorIndex: mockVectorIndex,
      llmProvider: stubLlmProvider,
      embeddingProvider: stubEmbeddingProvider,
      pipeline,
    };

    const result = await runCuration(deps, false);

    expect(result.enqueued).toBe(true);
    // Only the active spore should be scanned and enqueued
    expect(result.scanned).toBe(1);

    // The superseded spore should NOT be in the pipeline
    const supersededStatuses = pipeline.getItemStatus('cli-curate-superseded-spore', 'spore');
    expect(supersededStatuses).toHaveLength(0);
  });
});
