import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DigestEngine, Metabolism } from '@myco/daemon/digest';
import type { DigestEngineConfig, DigestCycleResult } from '@myco/daemon/digest';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { LlmProvider } from '@myco/intelligence/llm';
import type { MycoConfig } from '@myco/config/schema';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Helpers ---

function makeConfig(overrides: Partial<MycoConfig['digest']> = {}): MycoConfig {
  return {
    version: 2,
    intelligence: {
      llm: { provider: 'ollama', model: 'test', context_window: 8192, max_tokens: 1024 },
      embedding: { provider: 'ollama', model: 'test-embed' },
    },
    daemon: { log_level: 'info', grace_period: 30, max_log_size: 5_242_880 },
    capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: ['.md'], buffer_max_events: 500 },
    context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, spores: 300, team: 200 } },
    team: { enabled: false, user: '', sync: 'git' },
    digest: {
      enabled: true,
      tiers: [1500, 3000, 5000, 10000],
      inject_tier: 3000,
      intelligence: {
        provider: null,
        model: null,
        base_url: null,
        context_window: 32768,
      },
      metabolism: {
        active_interval: 300,
        cooldown_intervals: [900, 1800, 3600],
        dormancy_threshold: 7200,
      },
      substrate: {
        max_notes_per_cycle: 50,
      },
      ...overrides,
    },
  } as MycoConfig;
}

function makeNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'sessions/2026-03-15/session-abc123.md',
    type: 'session',
    id: 'abc123',
    title: 'Test Session',
    content: 'Did some work on the auth layer.',
    frontmatter: { type: 'session' },
    created: '2026-03-15T10:00:00Z',
    ...overrides,
  };
}

function makeMockIndex(notes: IndexedNote[] = []): MycoIndex {
  return {
    query: vi.fn().mockReturnValue(notes),
    getNoteByPath: vi.fn(),
    upsertNote: vi.fn(),
    deleteNote: vi.fn(),
    queryByIds: vi.fn(),
    close: vi.fn(),
    getPragma: vi.fn(),
    getDb: vi.fn(),
  } as unknown as MycoIndex;
}

function makeMockLlm(): LlmProvider {
  return {
    name: 'test',
    summarize: vi.fn().mockResolvedValue({ text: 'Synthesized context.', model: 'test-model' }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// --- DigestEngine Tests ---

describe('DigestEngine', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-digest-'));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  describe('discoverSubstrate', () => {
    it('returns notes when no timestamp provided (first run)', () => {
      const notes = [
        makeNote({ id: 's1', type: 'session' }),
        makeNote({ id: 's2', type: 'spore' }),
      ];
      const index = makeMockIndex(notes);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.discoverSubstrate(null);

      expect(index.query).toHaveBeenCalledWith({ limit: 50 });
      expect(result).toHaveLength(2);
    });

    it('passes updatedSince when timestamp provided', () => {
      const index = makeMockIndex([]);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      engine.discoverSubstrate('2026-03-15T10:00:00Z');

      expect(index.query).toHaveBeenCalledWith({
        updatedSince: '2026-03-15T10:00:00Z',
        limit: 50,
      });
    });

    it('returns empty when no notes found', () => {
      const index = makeMockIndex([]);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.discoverSubstrate(null);
      expect(result).toHaveLength(0);
    });

    it('filters out extract notes', () => {
      const notes = [
        makeNote({ id: 's1', type: 'session' }),
        makeNote({ id: 'e1', type: 'extract' }),
        makeNote({ id: 's2', type: 'spore' }),
      ];
      const index = makeMockIndex(notes);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.discoverSubstrate(null);
      expect(result).toHaveLength(2);
      expect(result.find((n) => n.type === 'extract')).toBeUndefined();
    });

    it('respects max_notes_per_cycle limit', () => {
      const notes = Array.from({ length: 10 }, (_, i) =>
        makeNote({ id: `s${i}`, type: 'session' }),
      );
      const index = makeMockIndex(notes);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig({ substrate: { max_notes_per_cycle: 3 } }),
      });

      const result = engine.discoverSubstrate(null);
      expect(result).toHaveLength(3);
    });

    it('sorts by type weight then recency', () => {
      const notes = [
        makeNote({ id: 'a1', type: 'artifact', created: '2026-03-15T12:00:00Z' }),
        makeNote({ id: 's1', type: 'session', created: '2026-03-15T10:00:00Z' }),
        makeNote({ id: 's2', type: 'session', created: '2026-03-15T11:00:00Z' }),
        makeNote({ id: 'p1', type: 'plan', created: '2026-03-15T09:00:00Z' }),
      ];
      const index = makeMockIndex(notes);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.discoverSubstrate(null);

      // Sessions (weight 3) should come before plans (weight 2) before artifacts (weight 1)
      expect(result[0].type).toBe('session');
      expect(result[1].type).toBe('session');
      // Within sessions, more recent first
      expect(result[0].id).toBe('s2');
      expect(result[1].id).toBe('s1');
      expect(result[2].type).toBe('plan');
      expect(result[3].type).toBe('artifact');
    });
  });

  describe('getEligibleTiers', () => {
    it('returns all tiers when context window is large', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig({ intelligence: { provider: null, model: null, base_url: null, context_window: 100000 } }),
      });

      const tiers = engine.getEligibleTiers();
      expect(tiers).toEqual([1500, 3000, 5000, 10000]);
    });

    it('filters tiers by context window', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig({ intelligence: { provider: null, model: null, base_url: null, context_window: 12000 } }),
      });

      const tiers = engine.getEligibleTiers();
      // 1500 needs 6500, 3000 needs 11500 — both fit in 12000
      // 5000 needs 18500 — too large
      expect(tiers).toEqual([1500, 3000]);
    });

    it('returns empty when context window is too small', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig({ intelligence: { provider: null, model: null, base_url: null, context_window: 5000 } }),
      });

      const tiers = engine.getEligibleTiers();
      expect(tiers).toEqual([]);
    });
  });

  describe('formatSubstrate', () => {
    it('formats notes within token budget', () => {
      const notes = [
        makeNote({ id: 's1', type: 'session', title: 'Auth work', content: 'Fixed auth bugs.' }),
        makeNote({ id: 's2', type: 'spore', title: 'CORS gotcha', content: 'Proxy strips headers.' }),
      ];

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.formatSubstrate(notes, 1000);
      expect(result).toContain('[session] s1');
      expect(result).toContain('"Auth work"');
      expect(result).toContain('Fixed auth bugs.');
      expect(result).toContain('[spore] s2');
    });

    it('stops adding notes when budget exceeded', () => {
      const longContent = 'x'.repeat(500);
      const notes = [
        makeNote({ id: 's1', content: longContent }),
        makeNote({ id: 's2', content: longContent }),
        makeNote({ id: 's3', content: longContent }),
      ];

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      // Budget for ~200 tokens = ~800 chars — should fit first note but not all three
      const result = engine.formatSubstrate(notes, 200);
      expect(result).toContain('s1');
      expect(result).not.toContain('s3');
    });

    it('always includes at least one note', () => {
      const longContent = 'y'.repeat(2000);
      const notes = [makeNote({ id: 's1', content: longContent })];

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = engine.formatSubstrate(notes, 10);
      expect(result).toContain('s1');
    });
  });

  describe('readPreviousExtract', () => {
    it('returns null when file does not exist', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      expect(engine.readPreviousExtract(1500)).toBeNull();
    });

    it('reads file and strips YAML frontmatter', () => {
      const digestDir = path.join(vaultDir, 'digest');
      fs.mkdirSync(digestDir, { recursive: true });
      fs.writeFileSync(
        path.join(digestDir, 'extract-1500.md'),
        '---\ntype: extract\ntier: 1500\n---\n\nThis is the synthesis body.\n',
        'utf-8',
      );

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const body = engine.readPreviousExtract(1500);
      expect(body).toBe('This is the synthesis body.');
    });

    it('returns full content if no frontmatter', () => {
      const digestDir = path.join(vaultDir, 'digest');
      fs.mkdirSync(digestDir, { recursive: true });
      fs.writeFileSync(
        path.join(digestDir, 'extract-3000.md'),
        'Plain content without frontmatter.\n',
        'utf-8',
      );

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const body = engine.readPreviousExtract(3000);
      expect(body).toBe('Plain content without frontmatter.');
    });
  });

  describe('writeExtract', () => {
    it('creates file with correct YAML frontmatter', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      engine.writeExtract(1500, 'Synthesized body.', 'cycle-123', 'test-model', 5);

      const filePath = path.join(vaultDir, 'digest', 'extract-1500.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('type: "extract"');
      expect(content).toContain('tier: 1500');
      expect(content).toContain('cycle_id: "cycle-123"');
      expect(content).toContain('substrate_count: 5');
      expect(content).toContain('model: "test-model"');
      expect(content).toContain('Synthesized body.');
    });

    it('creates digest directory if it does not exist', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      expect(fs.existsSync(path.join(vaultDir, 'digest'))).toBe(false);
      engine.writeExtract(3000, 'Body.', 'c1', 'model', 1);
      expect(fs.existsSync(path.join(vaultDir, 'digest'))).toBe(true);
    });

    it('uses atomic write (no .tmp file left behind)', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      engine.writeExtract(1500, 'Body.', 'c1', 'model', 1);

      const tmpPath = path.join(vaultDir, 'digest', 'extract-1500.md.tmp');
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  describe('appendTrace', () => {
    it('appends JSON line to trace.jsonl', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const record: DigestCycleResult = {
        cycleId: 'c1',
        timestamp: '2026-03-15T12:00:00Z',
        substrate: { sessions: ['s1'], spores: [], plans: [], artifacts: [], team: [] },
        tiersGenerated: [1500],
        model: 'test-model',
        durationMs: 1234,
        tokensUsed: 500,
      };

      engine.appendTrace(record);

      const tracePath = path.join(vaultDir, 'digest', 'trace.jsonl');
      expect(fs.existsSync(tracePath)).toBe(true);
      const content = fs.readFileSync(tracePath, 'utf-8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.cycleId).toBe('c1');
    });

    it('appends multiple records', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const base: DigestCycleResult = {
        cycleId: 'c1',
        timestamp: '2026-03-15T12:00:00Z',
        substrate: { sessions: [], spores: [], plans: [], artifacts: [], team: [] },
        tiersGenerated: [1500],
        model: 'test-model',
        durationMs: 100,
        tokensUsed: 100,
      };

      engine.appendTrace({ ...base, cycleId: 'c1' });
      engine.appendTrace({ ...base, cycleId: 'c2' });

      const tracePath = path.join(vaultDir, 'digest', 'trace.jsonl');
      const lines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
    });
  });

  describe('getLastCycleTimestamp', () => {
    it('returns null when no trace file exists', () => {
      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      expect(engine.getLastCycleTimestamp()).toBeNull();
    });

    it('returns null for empty trace file', () => {
      const digestDir = path.join(vaultDir, 'digest');
      fs.mkdirSync(digestDir, { recursive: true });
      fs.writeFileSync(path.join(digestDir, 'trace.jsonl'), '', 'utf-8');

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      expect(engine.getLastCycleTimestamp()).toBeNull();
    });

    it('reads timestamp from last record', () => {
      const digestDir = path.join(vaultDir, 'digest');
      fs.mkdirSync(digestDir, { recursive: true });
      const records = [
        { cycleId: 'c1', timestamp: '2026-03-15T10:00:00Z' },
        { cycleId: 'c2', timestamp: '2026-03-15T12:00:00Z' },
      ];
      fs.writeFileSync(
        path.join(digestDir, 'trace.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf-8',
      );

      const engine = new DigestEngine({
        vaultDir,
        index: makeMockIndex(),
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      expect(engine.getLastCycleTimestamp()).toBe('2026-03-15T12:00:00Z');
    });
  });

  describe('runCycle', () => {
    it('returns null when no substrate found', async () => {
      const index = makeMockIndex([]);
      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: makeMockLlm(),
        config: makeConfig(),
      });

      const result = await engine.runCycle();
      expect(result).toBeNull();
    });

    it('runs full cycle and writes extracts and trace', async () => {
      const notes = [
        makeNote({ id: 's1', type: 'session', title: 'Auth work', content: 'Fixed auth.' }),
        makeNote({ id: 'm1', type: 'spore', title: 'CORS issue', content: 'Proxy problem.' }),
      ];
      const index = makeMockIndex(notes);
      const llm = makeMockLlm();

      // Use only 1500 tier for speed
      const config = makeConfig({
        tiers: [1500],
        intelligence: { provider: null, model: null, base_url: null, context_window: 32768 },
      });

      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: llm,
        config,
      });

      const result = await engine.runCycle();

      expect(result).not.toBeNull();
      expect(result!.tiersGenerated).toContain(1500);
      expect(result!.model).toBe('test-model');
      expect(result!.substrate.sessions).toContain('s1');
      expect(result!.substrate.spores).toContain('m1');
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);

      // Verify extract was written
      const extractPath = path.join(vaultDir, 'digest', 'extract-1500.md');
      expect(fs.existsSync(extractPath)).toBe(true);
      const extractContent = fs.readFileSync(extractPath, 'utf-8');
      expect(extractContent).toContain('Synthesized context.');

      // Verify trace was written
      const tracePath = path.join(vaultDir, 'digest', 'trace.jsonl');
      expect(fs.existsSync(tracePath)).toBe(true);

      // Verify LLM was called with a prompt containing system + tier + substrate
      expect(llm.summarize).toHaveBeenCalledTimes(1);
      const promptArg = (llm.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(promptArg).toContain('digest engine');
      expect(promptArg).toContain('New Substrate');
    });

    it('includes previous extract in prompt when available', async () => {
      // Write a previous extract
      const digestDir = path.join(vaultDir, 'digest');
      fs.mkdirSync(digestDir, { recursive: true });
      fs.writeFileSync(
        path.join(digestDir, 'extract-1500.md'),
        '---\ntype: extract\ntier: 1500\n---\n\nPrevious synthesis content.\n',
        'utf-8',
      );

      const notes = [makeNote({ id: 's1', type: 'session' })];
      const index = makeMockIndex(notes);
      const llm = makeMockLlm();

      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: llm,
        config: makeConfig({
          tiers: [1500],
          intelligence: { provider: null, model: null, base_url: null, context_window: 32768 },
        }),
      });

      await engine.runCycle();

      const promptArg = (llm.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(promptArg).toContain('Previous Synthesis');
      expect(promptArg).toContain('Previous synthesis content.');
    });

    it('generates multiple tiers when eligible', async () => {
      const notes = [makeNote({ id: 's1', type: 'session' })];
      const index = makeMockIndex(notes);
      const llm = makeMockLlm();

      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: llm,
        config: makeConfig({
          tiers: [1500, 3000],
          intelligence: { provider: null, model: null, base_url: null, context_window: 32768 },
        }),
      });

      const result = await engine.runCycle();

      expect(result!.tiersGenerated).toEqual([1500, 3000]);
      expect(llm.summarize).toHaveBeenCalledTimes(2);

      // Both extract files should exist
      expect(fs.existsSync(path.join(vaultDir, 'digest', 'extract-1500.md'))).toBe(true);
      expect(fs.existsSync(path.join(vaultDir, 'digest', 'extract-3000.md'))).toBe(true);
    });

    it('tier gating: context_window 8192 produces only tier 1500', async () => {
      // 1500 needs 6500 (fits), 3000 needs 11500 (does not fit in 8192)
      const notes = [makeNote({ id: 's1', type: 'session', title: 'Auth work', content: 'Fixed auth.' })];
      const index = makeMockIndex(notes);
      const llm = makeMockLlm();

      const engine = new DigestEngine({
        vaultDir,
        index,
        llmProvider: llm,
        config: makeConfig({
          tiers: [1500, 3000, 5000, 10000],
          intelligence: { provider: null, model: null, base_url: null, context_window: 8192 },
        }),
      });

      const result = await engine.runCycle();

      expect(result).not.toBeNull();
      expect(result!.tiersGenerated).toEqual([1500]);
      expect(llm.summarize).toHaveBeenCalledTimes(1);

      // Only tier 1500 file should exist
      expect(fs.existsSync(path.join(vaultDir, 'digest', 'extract-1500.md'))).toBe(true);
      expect(fs.existsSync(path.join(vaultDir, 'digest', 'extract-3000.md'))).toBe(false);
    });
  });
});

// --- Metabolism Tests ---

describe('Metabolism', () => {
  const defaultConfig = {
    active_interval: 300,
    cooldown_intervals: [900, 1800, 3600],
    dormancy_threshold: 7200,
  };

  it('starts in active state with correct interval', () => {
    const metabolism = new Metabolism(defaultConfig);

    expect(metabolism.state).toBe('active');
    expect(metabolism.currentIntervalMs).toBe(300_000);
  });

  it('resets to active on substrate found', () => {
    const metabolism = new Metabolism(defaultConfig);
    metabolism.onEmptyCycle(); // cooling
    expect(metabolism.state).toBe('cooling');

    metabolism.onSubstrateFound();
    expect(metabolism.state).toBe('active');
    expect(metabolism.currentIntervalMs).toBe(300_000);
  });

  it('advances through cooldown steps on empty cycles', () => {
    const metabolism = new Metabolism(defaultConfig);

    metabolism.onEmptyCycle();
    expect(metabolism.state).toBe('cooling');
    expect(metabolism.currentIntervalMs).toBe(900_000);

    metabolism.onEmptyCycle();
    expect(metabolism.currentIntervalMs).toBe(1_800_000);

    metabolism.onEmptyCycle();
    expect(metabolism.currentIntervalMs).toBe(3_600_000);

    // Beyond last step — stays at last interval
    metabolism.onEmptyCycle();
    expect(metabolism.currentIntervalMs).toBe(3_600_000);
  });

  it('enters dormancy after threshold elapsed', () => {
    const metabolism = new Metabolism(defaultConfig);

    // Set last substrate to well in the past
    metabolism.markLastSubstrate(Date.now() - 7_200_001);
    metabolism.onEmptyCycle();

    expect(metabolism.state).toBe('dormant');
  });

  it('does not enter dormancy if threshold not reached', () => {
    const metabolism = new Metabolism(defaultConfig);

    metabolism.markLastSubstrate(Date.now() - 1000);
    metabolism.onEmptyCycle();

    expect(metabolism.state).toBe('cooling');
  });

  it('activates from dormancy', () => {
    const metabolism = new Metabolism(defaultConfig);

    // Force dormancy
    metabolism.markLastSubstrate(Date.now() - 7_200_001);
    metabolism.onEmptyCycle();
    expect(metabolism.state).toBe('dormant');

    metabolism.activate();
    expect(metabolism.state).toBe('active');
    expect(metabolism.currentIntervalMs).toBe(300_000);
  });

  it('ignores onEmptyCycle when already dormant', () => {
    const metabolism = new Metabolism(defaultConfig);

    metabolism.markLastSubstrate(Date.now() - 7_200_001);
    metabolism.onEmptyCycle();
    expect(metabolism.state).toBe('dormant');
    const intervalBefore = metabolism.currentIntervalMs;

    metabolism.onEmptyCycle();
    expect(metabolism.state).toBe('dormant');
    expect(metabolism.currentIntervalMs).toBe(intervalBefore);
  });

  it('stop() clears timer', () => {
    const metabolism = new Metabolism(defaultConfig);

    let callCount = 0;
    metabolism.start(async () => { callCount++; });
    metabolism.stop();

    // Timer was cleared — callback should not fire
    // We can't easily test timing, but verify stop doesn't throw
    expect(metabolism.state).toBe('active');
  });

  it('start() cancels previous timer', () => {
    const metabolism = new Metabolism(defaultConfig);

    let callCount = 0;
    metabolism.start(async () => { callCount++; });
    // Starting again should cancel the first timer
    metabolism.start(async () => { callCount += 10; });
    metabolism.stop();

    // No assertions on timing — just verify no exceptions
    expect(metabolism.state).toBe('active');
  });
});
