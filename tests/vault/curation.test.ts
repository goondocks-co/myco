import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSupersession } from '@myco/vault/curation';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { VectorIndex } from '@myco/index/vectors';
import type { LlmProvider, EmbeddingProvider } from '@myco/intelligence/llm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Helpers ---

function makeNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'spores/decision/decision-abc123.md',
    type: 'spore',
    id: 'decision-abc123',
    title: 'Test Decision',
    content: 'We decided to use X.',
    frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' },
    created: '2026-03-15T10:00:00Z',
    ...overrides,
  };
}

function makeMockIndex(notes: IndexedNote[] = []): MycoIndex {
  return {
    query: vi.fn().mockReturnValue(notes),
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

function makeMockVectorIndex(results: Array<{ id: string; similarity: number }> = []): VectorIndex {
  return {
    search: vi.fn().mockReturnValue(
      results.map((r) => ({ id: r.id, similarity: r.similarity, metadata: { type: 'spore' } }))
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

function makeMockLlm(response: string = '[]'): LlmProvider {
  return {
    name: 'test',
    summarize: vi.fn().mockResolvedValue({ text: response, model: 'test' }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/** Create a spore file on disk so supersedeSpore can write to it. */
function writeSporeFile(vaultDir: string, relativePath: string, id: string, content: string): void {
  const fullPath = path.join(vaultDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `---\ntype: spore\nid: ${id}\nobservation_type: decision\nstatus: active\ncreated: "2026-03-15T10:00:00Z"\ntags: []\n---\n\n# ${content}\n\n${content}\n`, 'utf-8');
}

// --- Tests ---

describe('checkSupersession', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-curation-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns empty when no vector results found', async () => {
    const newSpore = makeNote({ id: 'new-1' });
    const index = makeMockIndex([newSpore]);
    const vectorIndex = makeMockVectorIndex([]);

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: makeMockLlm(), vaultDir,
    });

    expect(result).toEqual([]);
  });

  it('returns empty when vectorIndex is null', async () => {
    const result = await checkSupersession('new-1', {
      index: makeMockIndex([makeNote({ id: 'new-1' })]),
      vectorIndex: null as unknown as VectorIndex,
      embeddingProvider: makeMockEmbedding(),
      llmProvider: makeMockLlm(),
      vaultDir,
    });

    expect(result).toEqual([]);
  });

  it('filters candidates by observation_type and active status', async () => {
    const newSpore = makeNote({ id: 'new-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const sameType = makeNote({ id: 'old-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const diffType = makeNote({ id: 'old-2', frontmatter: { type: 'spore', observation_type: 'gotcha', status: 'active' } });
    const superseded = makeNote({ id: 'old-3', frontmatter: { type: 'spore', observation_type: 'decision', status: 'superseded' } });

    const index = makeMockIndex([newSpore, sameType, diffType, superseded]);
    const vectorIndex = makeMockVectorIndex([
      { id: 'old-1', similarity: 0.9 },
      { id: 'old-2', similarity: 0.85 },
      { id: 'old-3', similarity: 0.8 },
    ]);

    const llm = makeMockLlm('[]');
    await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    // LLM should only see old-1 (same type, active)
    const prompt = (llm.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('old-1');
    expect(prompt).not.toContain('old-2');
    expect(prompt).not.toContain('old-3');
  });

  it('supersedes spores identified by LLM', async () => {
    const sporePath = 'spores/decision/decision-old-1.md';
    writeSporeFile(vaultDir, sporePath, 'old-1', 'Old approach');

    const newSpore = makeNote({ id: 'new-1', content: 'New approach' });
    const oldSpore = makeNote({ id: 'old-1', content: 'Old approach', path: sporePath });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm('["old-1"]');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    expect(result).toEqual(['old-1']);

    // Verify the file was updated
    const content = fs.readFileSync(path.join(vaultDir, sporePath), 'utf-8');
    expect(content).toContain('Superseded by::');
    expect(content).toContain('new-1');
  });

  it('skips LLM call when no candidates after filtering', async () => {
    const newSpore = makeNote({ id: 'new-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const diffType = makeNote({ id: 'old-1', frontmatter: { type: 'spore', observation_type: 'gotcha', status: 'active' } });

    const index = makeMockIndex([newSpore, diffType]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm();

    await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    expect(llm.summarize).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response gracefully', async () => {
    const newSpore = makeNote({ id: 'new-1' });
    const oldSpore = makeNote({ id: 'old-1' });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm('Sure! Here are the results: not json at all');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    expect(result).toEqual([]);
  });

  it('filters out hallucinated IDs from LLM response', async () => {
    const sporePath = 'spores/decision/decision-old-1.md';
    writeSporeFile(vaultDir, sporePath, 'old-1', 'Old approach');

    const newSpore = makeNote({ id: 'new-1' });
    const oldSpore = makeNote({ id: 'old-1', path: sporePath });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    // LLM returns a real ID and a hallucinated one
    const llm = makeMockLlm('["old-1", "does-not-exist"]');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    // old-1 succeeds (file exists), does-not-exist is filtered (not in candidates)
    expect(result).toEqual(['old-1']);
  });

  it('includes legacy spores without status field as candidates', async () => {
    const newSpore = makeNote({ id: 'new-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const legacySpore = makeNote({ id: 'old-1', frontmatter: { type: 'spore', observation_type: 'decision' } });

    const index = makeMockIndex([newSpore, legacySpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm('[]');

    await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir,
    });

    // Legacy spore (no status) should be included as a candidate
    expect(llm.summarize).toHaveBeenCalled();
    const prompt = (llm.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('old-1');
  });
});
