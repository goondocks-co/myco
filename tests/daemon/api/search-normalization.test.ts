import { describe, expect, it } from 'bun:test';
import { normalizeSearchNamespace } from '@myco/daemon/api/search.js';
import { normalizeSearchResults } from '@myco/search-results.js';

describe('normalizeSearchNamespace', () => {
  it('maps singular MCP type filters to semantic namespaces', () => {
    expect(normalizeSearchNamespace('session')).toBe('sessions');
    expect(normalizeSearchNamespace('spore')).toBe('spores');
    expect(normalizeSearchNamespace('plan')).toBe('plans');
    expect(normalizeSearchNamespace('artifact')).toBe('artifacts');
  });

  it('treats all as an unscoped semantic search', () => {
    expect(normalizeSearchNamespace('all')).toBeUndefined();
  });

  it('accepts already-normalized namespaces unchanged', () => {
    expect(normalizeSearchNamespace('plans')).toBe('plans');
    expect(normalizeSearchNamespace('artifacts')).toBe('artifacts');
  });
});

describe('normalizeSearchResults', () => {
  it('uses team table_name rows when building retrieve hints', () => {
    const results = normalizeSearchResults([
      {
        id: 'spore-remote',
        table_name: 'spores',
        content: 'team spore',
        score: 0.91,
        machine_id: 'remote-machine',
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        id: 'spore-remote',
        type: 'spore',
        title: 'spore-remote',
        preview: 'team spore',
        retrieve: { tool: 'myco_spores', input: { op: 'get', id: 'spore-remote' } },
      }),
    ]);
  });

  it('maps every retrievable entity type to its owning tool', () => {
    const results = normalizeSearchResults([
      { id: 'p1', table: 'plans', content: 'plan' },
      { id: 's1', type: 'sessions', summary: 'session' },
      { id: 'sk1', type: 'skill_records', description: 'skill' },
      { id: 'run1', type: 'runs', content: 'run' },
      { project_id: 'proj', path: 'src/app.ts', llm_description: 'file' },
    ]);

    expect(results.map((result) => result.retrieve)).toEqual([
      { tool: 'myco_plans', input: { op: 'get', id: 'p1' } },
      { tool: 'myco_sessions', input: { op: 'get', id: 's1' } },
      { tool: 'myco_skills', input: { op: 'get', id: 'sk1' } },
      { tool: 'myco_agent', input: { op: 'run', id: 'run1' } },
      { tool: 'myco_cortex', input: { op: 'canopy_entry', id: 'proj:src/app.ts', project_id: 'proj', path: 'src/app.ts' } },
    ]);
  });
});
