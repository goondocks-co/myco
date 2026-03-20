import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsolidationEngine } from '@myco/daemon/consolidation';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { VectorIndex } from '@myco/index/vectors';
import type { LlmProvider, EmbeddingProvider } from '@myco/intelligence/llm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Helpers ---

function makeNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'spores/gotcha/gotcha-abc123-1000.md',
    type: 'spore',
    id: 'gotcha-abc123-1000',
    title: 'Test Gotcha',
    content: 'This is a gotcha observation.',
    frontmatter: { type: 'spore', observation_type: 'gotcha', status: 'active' },
    created: '2026-03-15T10:00:00Z',
    ...overrides,
  };
}

function makeMockIndex(notes: IndexedNote[] = []): MycoIndex {
  return {
    query: vi.fn((opts?: any) => {
      if (opts?.since) {
        return notes.filter((n) => n.created > opts.since);
      }
      return notes;
    }),
    queryByIds: vi.fn((ids: string[]) =>
      notes.filter((n) => ids.includes(n.id))
    ),
    getNoteByPath: vi.fn(),
    upsertNote: vi.fn(),
    deleteNote: vi.fn(),
    close: vi.fn(),
    getPragma: vi.fn(),
    getDb: vi.fn(),
  } as unknown as MycoIndex;
}

function makeMockVectorIndex(
  results: Array<{ id: string; similarity: number }> = [],
): VectorIndex {
  return {
    search: vi.fn().mockReturnValue(
      results.map((r) => ({ id: r.id, similarity: r.similarity, metadata: { type: 'spore' } })),
    ),
    upsert: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
  } as unknown as VectorIndex;
}

function makeMockEmbedding(): EmbeddingProvider {
  return {
    name: 'test',
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], model: 'test', dimensions: 3 }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function makeMockLlm(response: string = '{"consolidate": false, "reason": "not similar enough"}'): LlmProvider {
  return {
    name: 'test',
    summarize: vi.fn().mockResolvedValue({ text: response, model: 'test' }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/** Write a spore file on disk so consolidateSpores can work with it. */
function writeSporeFile(
  vaultDir: string,
  relativePath: string,
  id: string,
  observationType: string = 'gotcha',
): void {
  const fullPath = path.join(vaultDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(
    fullPath,
    `---\ntype: spore\nid: "${id}"\nobservation_type: "${observationType}"\nstatus: active\ncreated: "2026-03-15T10:00:00Z"\ntags: []\n---\n\n# Test observation\n\nContent here.\n`,
    'utf-8',
  );
}

function makeEngine(
  vaultDir: string,
  notes: IndexedNote[] = [],
  vectorResults: Array<{ id: string; similarity: number }> = [],
  llmResponse: string = '{"consolidate": false}',
): {
  engine: ConsolidationEngine;
  index: MycoIndex;
  vectorIndex: VectorIndex;
  llmProvider: LlmProvider;
  embeddingProvider: EmbeddingProvider;
} {
  const index = makeMockIndex(notes);
  const vectorIndex = makeMockVectorIndex(vectorResults);
  const llmProvider = makeMockLlm(llmResponse);
  const embeddingProvider = makeMockEmbedding();

  const engine = new ConsolidationEngine({
    vaultDir,
    index,
    vectorIndex,
    llmProvider,
    embeddingProvider,
  });

  return { engine, index, vectorIndex, llmProvider, embeddingProvider };
}

// --- Tests ---

describe('ConsolidationEngine', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-consolidation-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns null when no new spores since last timestamp', async () => {
    const lastTimestamp = '2026-03-15T12:00:00Z';

    // Write a trace file with a timestamp
    const digestDir = path.join(vaultDir, 'digest');
    fs.mkdirSync(digestDir, { recursive: true });
    fs.writeFileSync(
      path.join(digestDir, 'consolidation-trace.jsonl'),
      JSON.stringify({ timestamp: lastTimestamp, sporesChecked: 0, clustersFound: 0, consolidated: 0, sporesSuperseded: 0, durationMs: 10 }) + '\n',
      'utf-8',
    );

    // Notes with created before the last timestamp will be filtered out by the mock
    const oldNote = makeNote({ id: 'gotcha-old-1', created: '2026-03-15T10:00:00Z' });
    const { engine } = makeEngine(vaultDir, [oldNote]);

    const result = await engine.runPass();
    expect(result).toBeNull();
  });

  it('skips clusters below minimum size — LLM is NOT called', async () => {
    // Only 2 spores in the cluster — below MIN_CLUSTER_SIZE of 3
    const spore1 = makeNote({ id: 'gotcha-1', created: '2026-03-15T10:00:00Z' });
    const spore2 = makeNote({ id: 'gotcha-2', created: '2026-03-15T11:00:00Z' });

    const { engine, llmProvider } = makeEngine(
      vaultDir,
      [spore1, spore2],
      [
        { id: 'gotcha-1', similarity: 0.95 },
        { id: 'gotcha-2', similarity: 0.90 },
      ],
    );

    const result = await engine.runPass();

    // LLM should NOT have been called (cluster too small)
    expect(llmProvider.summarize).not.toHaveBeenCalled();
    // No consolidations performed
    expect(result).not.toBeNull();
    expect(result?.consolidated).toBe(0);
  });

  it('consolidates when LLM approves a cluster of 3+ spores', async () => {
    const spore1 = makeNote({ id: 'gotcha-1', created: '2026-03-15T10:00:00Z', path: 'spores/gotcha/gotcha-1.md' });
    const spore2 = makeNote({ id: 'gotcha-2', created: '2026-03-15T10:01:00Z', path: 'spores/gotcha/gotcha-2.md' });
    const spore3 = makeNote({ id: 'gotcha-3', created: '2026-03-15T10:02:00Z', path: 'spores/gotcha/gotcha-3.md' });

    // Write actual files to disk so supersedeSpore can update them
    writeSporeFile(vaultDir, 'spores/gotcha/gotcha-1.md', 'gotcha-1');
    writeSporeFile(vaultDir, 'spores/gotcha/gotcha-2.md', 'gotcha-2');
    writeSporeFile(vaultDir, 'spores/gotcha/gotcha-3.md', 'gotcha-3');

    const approvalResponse = JSON.stringify({
      consolidate: true,
      title: 'Consolidated Gotcha: Pattern X',
      content: 'This wisdom note synthesizes three gotcha observations about pattern X.',
      source_ids: ['gotcha-1', 'gotcha-2', 'gotcha-3'],
      tags: ['pattern-x'],
    });

    const { engine, llmProvider } = makeEngine(
      vaultDir,
      [spore1, spore2, spore3],
      [
        { id: 'gotcha-1', similarity: 0.97 },
        { id: 'gotcha-2', similarity: 0.95 },
        { id: 'gotcha-3', similarity: 0.93 },
      ],
      approvalResponse,
    );

    const result = await engine.runPass();

    expect(llmProvider.summarize).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.consolidated).toBeGreaterThanOrEqual(1);
    expect(result?.sporesSuperseded).toBeGreaterThanOrEqual(3);

    // Verify trace was written
    const tracePath = path.join(vaultDir, 'digest', 'consolidation-trace.jsonl');
    expect(fs.existsSync(tracePath)).toBe(true);
    const traceContent = fs.readFileSync(tracePath, 'utf-8').trim();
    const traceRecord = JSON.parse(traceContent.split('\n').at(-1)!);
    expect(traceRecord.consolidated).toBeGreaterThanOrEqual(1);
  });

  it('respects LLM decline (consolidate: false) — no spores superseded', async () => {
    const spore1 = makeNote({ id: 'gotcha-a1', created: '2026-03-15T10:00:00Z' });
    const spore2 = makeNote({ id: 'gotcha-a2', created: '2026-03-15T10:01:00Z' });
    const spore3 = makeNote({ id: 'gotcha-a3', created: '2026-03-15T10:02:00Z' });

    const declineResponse = JSON.stringify({
      consolidate: false,
      reason: 'These observations are complementary, not overlapping.',
    });

    const { engine, llmProvider, index } = makeEngine(
      vaultDir,
      [spore1, spore2, spore3],
      [
        { id: 'gotcha-a1', similarity: 0.95 },
        { id: 'gotcha-a2', similarity: 0.92 },
        { id: 'gotcha-a3', similarity: 0.90 },
      ],
      declineResponse,
    );

    const result = await engine.runPass();

    expect(llmProvider.summarize).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.consolidated).toBe(0);
    expect(result?.sporesSuperseded).toBe(0);

    // No files should have been written with supersession notices
    // (verify by checking that upsertNote was not called for any supersession)
    const upsertCalls = (index.upsertNote as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls.length).toBe(0);
  });

  it('handles malformed LLM response gracefully — logs warning and continues', async () => {
    const spore1 = makeNote({ id: 'gotcha-b1', created: '2026-03-15T10:00:00Z' });
    const spore2 = makeNote({ id: 'gotcha-b2', created: '2026-03-15T10:01:00Z' });
    const spore3 = makeNote({ id: 'gotcha-b3', created: '2026-03-15T10:02:00Z' });

    const malformedResponse = 'Sure! These observations are related to pattern Y, I recommend consolidating them.';

    const warnings: string[] = [];
    const { engine } = makeEngine(
      vaultDir,
      [spore1, spore2, spore3],
      [
        { id: 'gotcha-b1', similarity: 0.95 },
        { id: 'gotcha-b2', similarity: 0.92 },
        { id: 'gotcha-b3', similarity: 0.90 },
      ],
      malformedResponse,
    );

    // Inject a custom log to capture warnings
    (engine as any).log = (level: string, message: string) => {
      if (level === 'warn') warnings.push(message);
    };

    // Should not throw
    const result = await engine.runPass();

    expect(result).not.toBeNull();
    expect(result?.consolidated).toBe(0);
    // Warning should have been logged
    expect(warnings.some((w) => w.toLowerCase().includes('parse') || w.toLowerCase().includes('malformed') || w.toLowerCase().includes('response'))).toBe(true);
  });

  it('getLastTimestamp reads from trace file', async () => {
    const digestDir = path.join(vaultDir, 'digest');
    fs.mkdirSync(digestDir, { recursive: true });
    const traceRecord = {
      timestamp: '2026-03-15T09:00:00Z',
      sporesChecked: 5,
      clustersFound: 1,
      consolidated: 1,
      sporesSuperseded: 3,
      durationMs: 200,
    };
    fs.writeFileSync(
      path.join(digestDir, 'consolidation-trace.jsonl'),
      JSON.stringify(traceRecord) + '\n',
      'utf-8',
    );

    const engine = new ConsolidationEngine({
      vaultDir,
      index: makeMockIndex(),
      vectorIndex: makeMockVectorIndex(),
      llmProvider: makeMockLlm(),
      embeddingProvider: makeMockEmbedding(),
    });

    expect(engine.getLastTimestamp()).toBe('2026-03-15T09:00:00Z');
  });

  it('returns null from getLastTimestamp when trace file does not exist', () => {
    const engine = new ConsolidationEngine({
      vaultDir,
      index: makeMockIndex(),
      vectorIndex: makeMockVectorIndex(),
      llmProvider: makeMockLlm(),
      embeddingProvider: makeMockEmbedding(),
    });

    expect(engine.getLastTimestamp()).toBeNull();
  });

  it('returns null when vectorIndex is not provided', async () => {
    const notes = [makeNote({ id: 'gotcha-c1', created: '2026-03-15T10:00:00Z' })];
    const engine = new ConsolidationEngine({
      vaultDir,
      index: makeMockIndex(notes),
      vectorIndex: null,
      llmProvider: makeMockLlm(),
      embeddingProvider: makeMockEmbedding(),
    });

    const result = await engine.runPass();
    expect(result).toBeNull();
  });

  it('returns null when llmProvider is not provided', async () => {
    const notes = [makeNote({ id: 'gotcha-d1', created: '2026-03-15T10:00:00Z' })];
    const engine = new ConsolidationEngine({
      vaultDir,
      index: makeMockIndex(notes),
      vectorIndex: makeMockVectorIndex(),
      llmProvider: null,
      embeddingProvider: makeMockEmbedding(),
    });

    const result = await engine.runPass();
    expect(result).toBeNull();
  });

  it('appends trace record after a pass and caches the timestamp', async () => {
    const spore1 = makeNote({ id: 'gotcha-e1', created: '2026-03-15T10:00:00Z' });
    const { engine } = makeEngine(vaultDir, [spore1], []);

    await engine.runPass();

    const tracePath = path.join(vaultDir, 'digest', 'consolidation-trace.jsonl');
    expect(fs.existsSync(tracePath)).toBe(true);

    // Timestamp should be cached
    const ts = engine.getLastTimestamp();
    expect(ts).not.toBeNull();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
