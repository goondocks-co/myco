import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleMycoContext } from '@myco/mcp/tools/context';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function writeExtract(digestDir: string, tier: number, body: string): void {
  fs.mkdirSync(digestDir, { recursive: true });
  const content = `---
type: "extract"
tier: ${tier}
generated: "2026-03-19T10:00:00.000Z"
cycle_id: "test-cycle"
substrate_count: 5
model: "test-model"
---

${body}
`;
  fs.writeFileSync(path.join(digestDir, `extract-${tier}.md`), content);
}

describe('myco_context', () => {
  let tmpDir: string;
  let digestDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-context-'));
    digestDir = path.join(tmpDir, 'digest');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns extract for requested tier', () => {
    writeExtract(digestDir, 3000, 'Project synthesis at 3000 tokens.');

    const result = handleMycoContext(tmpDir, { tier: 3000 });

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe('Project synthesis at 3000 tokens.');
    expect(result.generated).toBe('2026-03-19T10:00:00.000Z');
  });

  it('falls back to nearest tier when requested unavailable', () => {
    writeExtract(digestDir, 1500, 'Executive briefing.');
    writeExtract(digestDir, 5000, 'Deep onboarding.');

    const result = handleMycoContext(tmpDir, { tier: 3000 });

    // 1500 is distance 1500, 5000 is distance 2000 — should pick 1500
    expect(result.tier).toBe(1500);
    expect(result.fallback).toBe(true);
    expect(result.content).toBe('Executive briefing.');
  });

  it('returns not-ready message when no extracts exist', () => {
    const result = handleMycoContext(tmpDir, { tier: 3000 });

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('not yet available');
    expect(result.generated).toBeUndefined();
  });

  it('defaults to tier 3000 when no tier specified', () => {
    writeExtract(digestDir, 3000, 'Default tier content.');

    const result = handleMycoContext(tmpDir, {});

    expect(result.tier).toBe(3000);
    expect(result.content).toBe('Default tier content.');
  });

  it('returns exact tier over nearest when both exist', () => {
    writeExtract(digestDir, 3000, 'Exact match.');
    writeExtract(digestDir, 5000, 'Larger tier.');

    const result = handleMycoContext(tmpDir, { tier: 3000 });

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe('Exact match.');
  });
});
