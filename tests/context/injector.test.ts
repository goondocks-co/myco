import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildInjectedContext } from '@myco/context/injector';
import { MycoIndex } from '@myco/index/sqlite';
import { MycoConfigSchema } from '@myco/config/schema';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('buildInjectedContext', () => {
  let tmpDir: string;
  let index: MycoIndex;
  const config = MycoConfigSchema.parse({
    version: 1,
    intelligence: { backend: 'local' },
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ctx-'));
    index = new MycoIndex(path.join(tmpDir, 'index.db'));
  });

  afterEach(() => {
    index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty text for empty vault', () => {
    const result = buildInjectedContext(index, config, {});
    expect(result.text).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('includes active plans in layer 1', () => {
    index.upsertNote({
      path: 'plans/auth.md', type: 'plan', id: 'auth',
      title: 'Auth Redesign', content: 'Replace JWT.',
      frontmatter: { type: 'plan', status: 'active' },
      created: '2026-03-10T00:00:00Z',
    });

    const result = buildInjectedContext(index, config, {});
    expect(result.layers.plans).toContain('Auth Redesign');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('respects total max_tokens budget', () => {
    // Add many notes to potentially exceed budget
    for (let i = 0; i < 20; i++) {
      index.upsertNote({
        path: `sessions/s${i}.md`, type: 'session', id: `s${i}`,
        title: `Session ${i}`, content: 'A'.repeat(500),
        frontmatter: { type: 'session', started: new Date().toISOString() },
        created: new Date().toISOString(),
      });
    }

    const result = buildInjectedContext(index, config, {});
    expect(result.tokenEstimate).toBeLessThanOrEqual(config.context.max_tokens + 50);
  });
});
