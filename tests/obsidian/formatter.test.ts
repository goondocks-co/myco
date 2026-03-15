import { describe, it, expect } from 'vitest';
import {
  callout,
  inlineField,
  wikilink,
  observationCalloutType,
  buildTags,
  footerTags,
  formatSessionBody,
  formatMemoryBody,
  formatPlanBody,
  formatTeamBody,
  formatArtifactBody,
} from '../../src/obsidian/formatter.js';

describe('callout', () => {
  it('wraps content in Obsidian callout syntax', () => {
    const result = callout('warning', 'Watch Out', 'This is tricky.');
    expect(result).toBe('> [!warning] Watch Out\n> This is tricky.');
  });

  it('handles multiline content', () => {
    const result = callout('info', 'Note', 'Line 1\nLine 2');
    expect(result).toBe('> [!info] Note\n> Line 1\n> Line 2');
  });
});

describe('inlineField', () => {
  it('produces Dataview inline field', () => {
    expect(inlineField('Status', 'active')).toBe('Status:: active');
  });
});

describe('wikilink', () => {
  it('produces simple wikilink', () => {
    expect(wikilink('session-abc123')).toBe('[[session-abc123]]');
  });

  it('produces aliased wikilink', () => {
    expect(wikilink('gotcha-c5220-123', 'Stop Hook Throws')).toBe('[[gotcha-c5220-123|Stop Hook Throws]]');
  });
});

describe('observationCalloutType', () => {
  it('maps known types', () => {
    expect(observationCalloutType('gotcha')).toBe('warning');
    expect(observationCalloutType('bug_fix')).toBe('bug');
    expect(observationCalloutType('decision')).toBe('info');
    expect(observationCalloutType('discovery')).toBe('tip');
    expect(observationCalloutType('trade_off')).toBe('question');
  });

  it('defaults to note for unknown types', () => {
    expect(observationCalloutType('random_thing')).toBe('note');
    expect(observationCalloutType('')).toBe('note');
  });
});

describe('buildTags', () => {
  it('produces hierarchical tags', () => {
    const tags = buildTags('memory', 'bug_fix', ['auth', 'jwt']);
    expect(tags).toEqual(['type/memory', 'memory/bug-fix', 'auth', 'jwt']);
  });

  it('normalizes underscores to hyphens in subtype', () => {
    const tags = buildTags('memory', 'trade_off');
    expect(tags).toEqual(['type/memory', 'memory/trade-off']);
  });

  it('deduplicates extra tags', () => {
    const tags = buildTags('session', 'ended', ['user/chris', 'user/chris']);
    expect(tags).toEqual(['type/session', 'session/ended', 'user/chris']);
  });

  it('strips # prefix from extra tags', () => {
    const tags = buildTags('memory', 'gotcha', ['#auth']);
    expect(tags).toEqual(['type/memory', 'memory/gotcha', 'auth']);
  });

  it('skips empty subtype', () => {
    const tags = buildTags('team', '');
    expect(tags).toEqual(['type/team']);
  });

  it('replaces spaces with slashes in extra tags', () => {
    const tags = buildTags('artifact', 'spec', ['daemon logs']);
    expect(tags).toEqual(['type/artifact', 'artifact/spec', 'daemon/logs']);
  });

  it('handles multiple spaces in a tag', () => {
    const tags = buildTags('artifact', 'spec', ['log viewer design']);
    expect(tags).toEqual(['type/artifact', 'artifact/spec', 'log/viewer/design']);
  });
});

describe('footerTags', () => {
  it('prefixes tags with #', () => {
    expect(footerTags(['type/session', 'user/chris'])).toBe('#type/session #user/chris');
  });

  it('does not double-prefix', () => {
    expect(footerTags(['#already'])).toBe('#already');
  });
});

describe('formatSessionBody', () => {
  it('produces full session body with all sections', () => {
    const body = formatSessionBody({
      title: 'Auth Refactor Session',
      narrative: 'Refactored JWT handling.',
      sessionId: 'abc123',
      user: 'chris',
      started: '2026-03-13T10:00:00Z',
      ended: '2026-03-13T11:22:00Z',
      branch: 'feat/auth',
      relatedMemories: [{ id: 'gotcha-c5220-123', title: 'Stop Hook Throws' }],
      turns: [
        { prompt: 'Fix the JWT rotation', toolCount: 5, aiResponse: 'Done.' },
      ],
    });

    expect(body).toContain('# Auth Refactor Session');
    expect(body).toContain('> [!abstract] Summary');
    expect(body).toContain('> Refactored JWT handling.');
    expect(body).toContain('Session:: [[session-abc123]]');
    expect(body).toContain('User:: chris');
    expect(body).toContain('Duration:: 1h 22m');
    expect(body).toContain('Branch:: `feat/auth`');
    expect(body).toContain('## Related Memories');
    expect(body).toContain('[[gotcha-c5220-123|Stop Hook Throws]]');
    expect(body).toContain('### Turn 1');
    expect(body).toContain('> [!user] Prompt');
    expect(body).toContain('**Tools**: 5 calls');
    expect(body).toContain('> [!assistant] Response');
    expect(body).toContain('#type/session');
    expect(body).toContain('#user/chris');
  });

  it('preserves existing conversation and appends new turns', () => {
    const existing = '## Conversation\n\n### Turn 1\n\n> [!user] Prompt\n> First thing\n\n### Turn 2\n\n> [!user] Prompt\n> Second thing\n\n### Turn 3\n\n> [!user] Prompt\n> Third thing';
    const body = formatSessionBody({
      title: 'Continued',
      narrative: '',
      sessionId: 'abc',
      turns: [{ prompt: 'Next thing', toolCount: 0 }],
      existingTurnCount: 3,
      existingConversation: existing,
    });

    expect(body).toContain('### Turn 4');
    expect(body).toContain('### Turn 1');
    expect(body).toContain('### Turn 2');
    expect(body).toContain('### Turn 3');
    expect(body).toContain('Next thing');
  });

  it('handles missing optional fields gracefully', () => {
    const body = formatSessionBody({
      title: 'Minimal',
      narrative: '',
      sessionId: 'xyz',
      turns: [],
    });

    expect(body).toContain('# Minimal');
    expect(body).toContain('Session:: [[session-xyz]]');
    expect(body).not.toContain('Duration');
    expect(body).not.toContain('Branch');
    expect(body).not.toContain('## Related Memories');
    expect(body).not.toContain('## Conversation');
  });
});

describe('formatMemoryBody', () => {
  it('produces memory body with typed callout', () => {
    const body = formatMemoryBody({
      title: 'RS256 over HS256',
      observationType: 'decision',
      content: 'Chose RS256 for key rotation.',
      sessionId: 'abc123',
      rationale: 'Asymmetric key rotation support.',
      alternatives_rejected: '**HS256** — no key rotation',
    });

    expect(body).toContain('# RS256 over HS256');
    expect(body).toContain('> [!info] Decision');
    expect(body).toContain('> Chose RS256 for key rotation.');
    expect(body).toContain('Session:: [[session-abc123]]');
    expect(body).toContain('Observation:: decision');
    expect(body).toContain('## Rationale');
    expect(body).toContain('## Alternatives Rejected');
    expect(body).toContain('#type/memory');
    expect(body).toContain('#memory/decision');
  });

  it('produces bug_fix body with root cause and fix sections', () => {
    const body = formatMemoryBody({
      title: 'NPE in stop hook',
      observationType: 'bug_fix',
      content: 'Null check missing.',
      root_cause: 'Session was undefined.',
      fix: 'Added guard clause.',
    });

    expect(body).toContain('> [!bug] Bug-fix');
    expect(body).toContain('## Root Cause');
    expect(body).toContain('## Fix');
  });

  it('produces trade_off body with gained/sacrificed', () => {
    const body = formatMemoryBody({
      title: 'Dropped SQLite for FTS',
      observationType: 'trade_off',
      content: 'Simplified index.',
      gained: 'Faster queries.',
      sacrificed: 'No vector support.',
    });

    expect(body).toContain('> [!question] Trade-off');
    expect(body).toContain('## Gained');
    expect(body).toContain('## Sacrificed');
  });

  it('handles missing optional fields', () => {
    const body = formatMemoryBody({
      title: 'Simple note',
      observationType: 'discovery',
      content: 'Found a thing.',
    });

    expect(body).toContain('> [!tip] Discovery');
    expect(body).not.toContain('Session::');
    expect(body).not.toContain('## Root Cause');
    expect(body).toContain('#type/memory');
    expect(body).toContain('#memory/discovery');
  });
});

describe('formatPlanBody', () => {
  it('wraps content with inline fields and footer tags', () => {
    const body = formatPlanBody({
      id: 'auth-overhaul',
      status: 'in_progress',
      author: 'chris',
      created: '2026-03-13',
      content: '# Auth Overhaul\n\nRewrite the auth layer.',
      tags: ['auth'],
    });

    expect(body).toContain('Plan:: [[auth-overhaul]]');
    expect(body).toContain('Status:: in_progress');
    expect(body).toContain('Author:: chris');
    expect(body).toContain('# Auth Overhaul');
    expect(body).toContain('#type/plan');
    expect(body).toContain('#plan/in-progress');
    expect(body).toContain('#auth');
  });

  it('includes sessions section when provided', () => {
    const body = formatPlanBody({
      id: 'plan-1',
      status: 'active',
      content: 'Do things.',
      sessions: [{ id: 'abc', title: 'First session' }],
    });

    expect(body).toContain('## Sessions');
    expect(body).toContain('[[session-abc|First session]]');
  });
});

describe('formatTeamBody', () => {
  it('produces team member body with callout', () => {
    const body = formatTeamBody({
      user: 'chris',
      role: 'Lead',
      recentSessions: [{ id: 'abc', title: 'Auth work' }],
    });

    expect(body).toContain('# chris');
    expect(body).toContain('> [!info] Team Member');
    expect(body).toContain('> Lead');
    expect(body).toContain('User:: chris');
    expect(body).toContain('Role:: Lead');
    expect(body).toContain('## Recent Sessions');
    expect(body).toContain('[[session-abc|Auth work]]');
    expect(body).toContain('#type/team');
    expect(body).toContain('#user/chris');
  });

  it('defaults role to Contributor in callout', () => {
    const body = formatTeamBody({ user: 'newbie' });
    expect(body).toContain('> Contributor');
  });
});

describe('formatArtifactBody', () => {
  it('produces artifact body with inline fields and content', () => {
    const body = formatArtifactBody({
      id: 'docs-specs-auth-design',
      title: 'Auth Redesign Specification',
      artifact_type: 'spec',
      source_path: 'docs/specs/auth-design.md',
      sessionId: 'abc123',
      content: '# Auth Redesign\n\nRedesign the auth layer.',
      tags: ['auth', 'api'],
    });

    expect(body).toContain('Artifact:: [[docs-specs-auth-design]]');
    expect(body).toContain('Source:: `docs/specs/auth-design.md`');
    expect(body).toContain('Type:: spec');
    expect(body).toContain('Session:: [[session-abc123]]');
    expect(body).toContain('# Auth Redesign');
    expect(body).toContain('Redesign the auth layer.');
    expect(body).toContain('#type/artifact');
    expect(body).toContain('#artifact/spec');
    expect(body).toContain('#auth');
    expect(body).toContain('#api');
  });

  it('handles missing optional tags', () => {
    const body = formatArtifactBody({
      id: 'readme',
      title: 'Project README',
      artifact_type: 'doc',
      source_path: 'README.md',
      sessionId: 'xyz',
      content: '# Hello World',
    });

    expect(body).toContain('Artifact:: [[readme]]');
    expect(body).toContain('#type/artifact');
    expect(body).toContain('#artifact/doc');
    expect(body).not.toContain('#auth');
  });
});
