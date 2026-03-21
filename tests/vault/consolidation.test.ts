import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consolidateSpores } from '@myco/vault/consolidation';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { VectorIndex } from '@myco/index/vectors';
import type { EmbeddingProvider } from '@myco/intelligence/llm';
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

function makeMockVectorIndex(deleteImpl?: () => void): VectorIndex {
  return {
    search: vi.fn().mockReturnValue([]),
    upsert: vi.fn(),
    delete: vi.fn(deleteImpl ?? (() => {})),
    getEmbedding: vi.fn().mockReturnValue(null),
    has: vi.fn().mockReturnValue(false),
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

/** Write a minimal spore file on disk so supersedeSpore can operate on it. */
function writeSporeFile(vaultDir: string, relativePath: string, id: string): void {
  const fullPath = path.join(vaultDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(
    fullPath,
    `---\ntype: spore\nid: "${id}"\nobservation_type: "decision"\nstatus: "active"\ncreated: "2026-03-15T10:00:00Z"\ntags: []\n---\n\n# ${id}\n\nContent of ${id}.\n`,
    'utf-8',
  );
}

// --- Tests ---

describe('consolidateSpores', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-consolidation-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('creates a wisdom note with correct ID pattern', async () => {
    const index = makeMockIndex([]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: [],
        consolidatedContent: 'Consolidated wisdom.',
        observationType: 'decision',
        tags: ['important'],
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    // ID pattern: {type}-wisdom-{hex8}
    expect(result.wisdom_id).toMatch(/^decision-wisdom-[0-9a-f]{8}$/);
    expect(result.wisdom_path).toContain(result.wisdom_id);
    expect(result.sources_archived).toBe(0);
  });

  it('writes the wisdom note to disk', async () => {
    const index = makeMockIndex([]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: [],
        consolidatedContent: 'Wisdom content here.',
        observationType: 'gotcha',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    const wisdomFullPath = path.join(vaultDir, result.wisdom_path);
    expect(fs.existsSync(wisdomFullPath)).toBe(true);

    const fileContent = fs.readFileSync(wisdomFullPath, 'utf-8');
    expect(fileContent).toContain('Wisdom content here.');
    expect(fileContent).toContain('wisdom');
    expect(fileContent).toContain('consolidated');
  });

  it('creates ## Sources section with wikilinks to source spores', async () => {
    const sporePath1 = 'spores/decision/decision-aaa111.md';
    const sporePath2 = 'spores/decision/decision-bbb222.md';
    writeSporeFile(vaultDir, sporePath1, 'decision-aaa111');
    writeSporeFile(vaultDir, sporePath2, 'decision-bbb222');

    const sourceNote1 = makeNote({ id: 'decision-aaa111', path: sporePath1 });
    const sourceNote2 = makeNote({ id: 'decision-bbb222', path: sporePath2 });
    const index = makeMockIndex([sourceNote1, sourceNote2]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: ['decision-aaa111', 'decision-bbb222'],
        consolidatedContent: 'Merged insight.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    const wisdomContent = fs.readFileSync(path.join(vaultDir, result.wisdom_path), 'utf-8');
    expect(wisdomContent).toContain('## Sources');
    expect(wisdomContent).toContain('[[decision-aaa111]]');
    expect(wisdomContent).toContain('[[decision-bbb222]]');
  });

  it('adds consolidated_from to wisdom note frontmatter', async () => {
    const sporePath = 'spores/decision/decision-src001.md';
    writeSporeFile(vaultDir, sporePath, 'decision-src001');
    const sourceNote = makeNote({ id: 'decision-src001', path: sporePath });
    const index = makeMockIndex([sourceNote]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: ['decision-src001'],
        consolidatedContent: 'Wisdom from one source.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    const wisdomContent = fs.readFileSync(path.join(vaultDir, result.wisdom_path), 'utf-8');
    expect(wisdomContent).toContain('consolidated_from');
    expect(wisdomContent).toContain('decision-src001');
  });

  it('marks source spores as superseded using supersedeSpore', async () => {
    const sporePath1 = 'spores/decision/decision-s001.md';
    const sporePath2 = 'spores/decision/decision-s002.md';
    writeSporeFile(vaultDir, sporePath1, 'decision-s001');
    writeSporeFile(vaultDir, sporePath2, 'decision-s002');

    const note1 = makeNote({ id: 'decision-s001', path: sporePath1 });
    const note2 = makeNote({ id: 'decision-s002', path: sporePath2 });
    const index = makeMockIndex([note1, note2]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: ['decision-s001', 'decision-s002'],
        consolidatedContent: 'Synthesized knowledge.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    expect(result.sources_archived).toBe(2);

    // Each source should have supersession notice and status
    for (const sp of [sporePath1, sporePath2]) {
      const content = fs.readFileSync(path.join(vaultDir, sp), 'utf-8');
      expect(content).toContain('status: "superseded"');
      expect(content).toContain('superseded_by');
      expect(content).toContain('Superseded by::');
      expect(content).toContain(result.wisdom_id);
    }
  });

  it('deletes source spore vectors when vectorIndex is provided', async () => {
    const sporePath = 'spores/decision/decision-vec001.md';
    writeSporeFile(vaultDir, sporePath, 'decision-vec001');
    const sourceNote = makeNote({ id: 'decision-vec001', path: sporePath });
    const index = makeMockIndex([sourceNote]);

    const deleteMock = vi.fn();
    const vectorIndex = makeMockVectorIndex(deleteMock);

    await consolidateSpores(
      {
        sourceSporeIds: ['decision-vec001'],
        consolidatedContent: 'Wisdom.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex, embeddingProvider: null },
    );

    expect(deleteMock).toHaveBeenCalledWith('decision-vec001');
  });

  it('embeds the wisdom note when vectorIndex and embeddingProvider are provided', async () => {
    const index = makeMockIndex([]);
    const vectorIndex = makeMockVectorIndex();
    const embeddingProvider = makeMockEmbedding();

    const result = await consolidateSpores(
      {
        sourceSporeIds: [],
        consolidatedContent: 'Embedded wisdom.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex, embeddingProvider },
    );

    // Give the fire-and-forget embedding a chance to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(embeddingProvider.embed).toHaveBeenCalled();
    expect((vectorIndex.upsert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      result.wisdom_id,
      expect.any(Array),
      expect.objectContaining({ importance: 'high' }),
    );
  });

  it('works without vector index (graceful degradation)', async () => {
    const index = makeMockIndex([]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: [],
        consolidatedContent: 'No vectors needed.',
        observationType: 'discovery',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    expect(result.wisdom_id).toMatch(/^discovery-wisdom-[0-9a-f]{8}$/);
    expect(result.sources_archived).toBe(0);
  });

  it('skips source spores not found in index', async () => {
    // 'missing-id' is not in the index
    const index = makeMockIndex([]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: ['missing-id'],
        consolidatedContent: 'Partial consolidation.',
        observationType: 'decision',
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    // No sources archived since the ID was not found
    expect(result.sources_archived).toBe(0);
  });

  it('includes provided tags plus wisdom and consolidated on the wisdom note', async () => {
    const index = makeMockIndex([]);

    const result = await consolidateSpores(
      {
        sourceSporeIds: [],
        consolidatedContent: 'Tagged wisdom.',
        observationType: 'decision',
        tags: ['architecture', 'backend'],
      },
      { vaultDir, index, vectorIndex: null, embeddingProvider: null },
    );

    const content = fs.readFileSync(path.join(vaultDir, result.wisdom_path), 'utf-8');
    expect(content).toContain('wisdom');
    expect(content).toContain('consolidated');
    expect(content).toContain('architecture');
    expect(content).toContain('backend');
  });
});
