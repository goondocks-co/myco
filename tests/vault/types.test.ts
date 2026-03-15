import { describe, it, expect } from 'vitest';
import {
  SessionFrontmatterSchema,
  PlanFrontmatterSchema,
  MemoryFrontmatterSchema,
  ArtifactFrontmatterSchema,
  TeamMemberFrontmatterSchema,
  parseNoteFrontmatter,
} from '@myco/vault/types';

describe('Vault Note Types', () => {
  it('validates session frontmatter', () => {
    const fm = {
      type: 'session',
      id: 'a1b2c3',
      agent: 'claude-code',
      user: 'chris',
      started: '2026-03-12T09:15:00Z',
      tags: ['auth'],
    };
    const result = SessionFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(true);
  });

  it('validates plan frontmatter', () => {
    const fm = {
      type: 'plan',
      id: 'auth-redesign',
      status: 'in_progress',
      created: '2026-03-10T14:00:00Z',
      author: 'chris',
      tags: ['auth'],
    };
    const result = PlanFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(true);
  });

  it('validates memory frontmatter', () => {
    const fm = {
      type: 'memory',
      id: 'gotcha-cors',
      observation_type: 'gotcha',
      session: '[[session-a1b2c3]]',
      created: '2026-03-12T10:00:00Z',
      tags: ['cors'],
    };
    const result = MemoryFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(true);
  });

  it('validates artifact frontmatter', () => {
    const fm = {
      type: 'artifact',
      id: 'docs-specs-design',
      source_path: 'docs/specs/design.md',
      artifact_type: 'spec',
      title: 'Design Specification',
      last_captured_by: 'session-a1b2c3',
      created: '2026-03-12T10:30:00Z',
      updated: '2026-03-12T10:30:00Z',
      tags: ['design'],
    };
    const result = ArtifactFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(true);
  });

  it('validates team member frontmatter', () => {
    const fm = {
      type: 'team-member',
      user: 'chris',
      joined: '2026-03-12T00:00:00Z',
    };
    const result = TeamMemberFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(true);
  });

  it('parseNoteFrontmatter dispatches by type', () => {
    const sessionFm = { type: 'session', id: 'x', agent: 'claude-code', user: 'chris', started: '2026-03-12T09:00:00Z' };
    const result = parseNoteFrontmatter(sessionFm);
    expect(result.type).toBe('session');
  });

  it('parseNoteFrontmatter rejects unknown type', () => {
    expect(() => parseNoteFrontmatter({ type: 'invalid' })).toThrow();
  });

  it('accepts new observation types', () => {
    for (const type of ['gotcha', 'bug_fix', 'decision', 'discovery', 'trade_off']) {
      const result = MemoryFrontmatterSchema.safeParse({
        type: 'memory', id: 'test', observation_type: type, created: '2026-01-01',
      });
      expect(result.success, `${type} should be valid`).toBe(true);
    }
  });

  it('accepts arbitrary observation types like cross-cutting', () => {
    const result = MemoryFrontmatterSchema.safeParse({
      type: 'memory', id: 'test', observation_type: 'cross-cutting', created: '2026-01-01',
    });
    expect(result.success).toBe(true);
  });

  it('accepts plans array on session frontmatter', () => {
    const result = SessionFrontmatterSchema.safeParse({
      type: 'session', id: 's1', agent: 'claude', user: 'chris',
      started: '2026-01-01', plans: ['plan-a', 'plan-b'],
    });
    expect(result.success).toBe(true);
    expect(result.data?.plans).toEqual(['plan-a', 'plan-b']);
  });

  it('handles backward compat: single plan string still accepted', () => {
    const result = SessionFrontmatterSchema.safeParse({
      type: 'session', id: 's1', agent: 'claude', user: 'chris',
      started: '2026-01-01', plan: 'plan-a',
    });
    expect(result.success).toBe(true);
  });
});
