import { describe, expect, it } from 'bun:test';

import {
  assessCandidateEvidence,
  parseSourceRefs,
  renderEvidenceBundleForPrompt,
  renderEvidenceBundlesForPrompt,
  type SkillCandidateEvidenceBundle,
} from '@myco/agent/skill-candidate-evidence.js';

describe('parseSourceRefs', () => {
  it('returns valid typed refs from JSON input', () => {
    expect(parseSourceRefs(JSON.stringify([
      { id: 'spore-1', type: 'spore' },
      { id: 'session-1', type: 'session' },
      { id: 'plan-1', type: 'plan' },
      { id: 'artifact-1', type: 'artifact' },
    ]))).toEqual([
      { id: 'spore-1', type: 'spore' },
      { id: 'session-1', type: 'session' },
      { id: 'plan-1', type: 'plan' },
      { id: 'artifact-1', type: 'artifact' },
    ]);
  });

  it('returns an empty array for malformed JSON and non-array JSON', () => {
    expect(parseSourceRefs('{not-json')).toEqual([]);
    expect(parseSourceRefs(JSON.stringify({ id: 'spore-1', type: 'spore' }))).toEqual([]);
  });

  it('ignores entries with malformed fields or unsupported types', () => {
    expect(parseSourceRefs(JSON.stringify([
      { id: 'spore-1', type: 'spore' },
      { id: 123, type: 'spore' },
      { id: ' ', type: 'spore' },
      { id: 'bad-type', type: 'note' },
      { id: 'missing-type' },
      null,
    ]))).toEqual([{ id: 'spore-1', type: 'spore' }]);
  });

  it('accepts legacy string refs only when their type is inferable', () => {
    expect(parseSourceRefs(JSON.stringify([
      'spore-1',
      'session-1',
      'sess-abc',
      'plan-1',
      'artifact-1',
      'unknown-1',
      ' ',
    ]))).toEqual([
      { id: 'spore-1', type: 'spore' },
      { id: 'session-1', type: 'session' },
      { id: 'sess-abc', type: 'session' },
      { id: 'plan-1', type: 'plan' },
      { id: 'artifact-1', type: 'artifact' },
    ]);
  });
});

describe('assessCandidateEvidence', () => {
  it('passes strong project-specific evidence', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Multiple sessions showed that hook or daemon changes require `make build` and `myco-dev restart` before verification.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
      activeSkills: ['SQLite query patterns'],
      existingCandidates: ['Cloudflare worker deploy flow'],
    });

    expect(result.failures).toEqual([]);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('fails low source count', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
    });

    expect(result.failures).toContain('insufficient-source-refs');
    expect(result.score).toBeLessThan(1);
  });

  it('fails low distinct sessions unless consolidating existing wisdom', () => {
    const weak = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1'],
    });
    expect(weak.failures).toContain('insufficient-distinct-sessions');

    const wisdom = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'spore-3', type: 'spore' },
      ],
      sourceSessions: ['session-1'],
      consolidatesWisdom: true,
    });
    expect(wisdom.failures).not.toContain('insufficient-distinct-sessions');
  });

  it('flags missing project anchors', () => {
    const result = assessCandidateEvidence({
      topic: 'Testing habits',
      rationale: 'The team should write reliable tests before changing behavior.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
    });

    expect(result.failures).toContain('missing-project-anchor');
  });

  it('keeps missing project anchor failures below the selection threshold', () => {
    const result = assessCandidateEvidence({
      topic: 'Testing habits',
      rationale: 'The team should write reliable tests before changing behavior.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
    });

    expect(result.failures).toEqual(['missing-project-anchor']);
    expect(result.score).toBeLessThan(0.7);
  });

  it('keeps overlap failures below the selection threshold', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Multiple sessions showed that hook or daemon changes require `make build` and `myco-dev restart` before verification.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
      activeSkills: [
        {
          name: 'daemon-process-lifecycle-management',
          description: 'Use when managing daemon process lifecycle, restarts, and runtime verification.',
        },
      ],
    });

    expect(result.failures).toEqual(['active-skill-overlap']);
    expect(result.score).toBeLessThan(0.7);
  });

  it('counts distinct valid source refs for the source gate', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-1', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
    });

    expect(result.failures).toContain('insufficient-source-refs');
  });

  it('ignores blank source ref ids for the source gate', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: ' ', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
    });

    expect(result.failures).toContain('insufficient-source-refs');
  });

  it('degrades on malformed runtime source refs', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Anchored to `make build` and `myco-dev restart`.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        null,
        { id: 'session-1', type: 'not-a-type' },
        { id: 'session-1', type: 'session' },
      ] as unknown as SkillCandidateEvidenceBundle['sourceRefs'],
      sourceSessions: [{ id: 'session-2' }, { id: ' ' }, null],
    });

    expect(result.failures).toContain('insufficient-source-refs');
    expect(result.failures).not.toContain('missing-project-anchor');
  });

  it('flags active skill and existing candidate overlap', () => {
    const result = assessCandidateEvidence({
      topic: 'Daemon restart workflow',
      rationale: 'Multiple sessions showed that hook or daemon changes require `make build` and `myco-dev restart` before verification.',
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'spore-2', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
      sourceSessions: ['session-1', 'session-2'],
      activeSkills: [
        {
          name: 'daemon-process-lifecycle-management',
          description: 'Use when managing daemon process lifecycle, restarts, and runtime verification.',
        },
      ],
      existingCandidates: [
        {
          id: 'candidate-existing',
          topic: 'Daemon restart and verification workflow',
          rationale: 'Existing candidate about daemon restart verification.',
        },
      ],
    });

    expect(result.failures).toContain('active-skill-overlap');
    expect(result.failures).toContain('existing-candidate-overlap');
    expect(result.coverageMatches).toContain('active-skill:daemon-process-lifecycle-management');
    expect(result.coverageMatches).toContain('candidate:candidate-existing');
  });
});

describe('renderEvidenceBundleForPrompt', () => {
  it('includes id, topic, score, failures, coverage matches, and source ids', () => {
    const bundle: SkillCandidateEvidenceBundle = {
      id: 'bundle-1',
      topic: 'Daemon restart workflow',
      score: 0.72,
      failures: ['active-skill-overlap'],
      coverageMatches: ['active-skill:daemon-process-lifecycle-management'],
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: 'session-1', type: 'session' },
      ],
    };

    const rendered = renderEvidenceBundleForPrompt(bundle);

    expect(rendered).toContain('bundle-1');
    expect(rendered).toContain('Daemon restart workflow');
    expect(rendered).toContain('0.72');
    expect(rendered).toContain('active-skill-overlap');
    expect(rendered).toContain('active-skill:daemon-process-lifecycle-management');
    expect(rendered).toContain('spore:spore-1');
    expect(rendered).toContain('session:session-1');
  });

  it('degrades on malformed runtime bundle fields', () => {
    const bundle = {
      id: 123,
      topic: null,
      score: 'bad',
      failures: 'active-skill-overlap',
      coverageMatches: null,
      sourceRefs: [
        { id: 'spore-1', type: 'spore' },
        { id: ' ', type: 'spore' },
        { id: 'bad', type: 'note' },
      ],
    } as unknown as SkillCandidateEvidenceBundle;

    expect(() => renderEvidenceBundleForPrompt(bundle)).not.toThrow();
    expect(renderEvidenceBundleForPrompt(bundle)).toContain('spore:spore-1');
  });
});

describe('renderEvidenceBundlesForPrompt', () => {
  it('renders only the empty section heading for zero bundles', () => {
    expect(renderEvidenceBundlesForPrompt([])).toBe('### Candidate Evidence Bundles (0)');
  });

  it('degrades on malformed runtime bundle arrays', () => {
    const bundles = [
      {
        id: 2,
        topic: 'Second',
        score: Number.NaN,
        failures: [],
        coverageMatches: [],
        sourceRefs: [],
      },
      null,
      {
        id: 'bundle-1',
        topic: 'First',
        score: 1,
        failures: [],
        coverageMatches: [],
        sourceRefs: [],
      },
    ] as unknown as SkillCandidateEvidenceBundle[];

    expect(() => renderEvidenceBundlesForPrompt(bundles)).not.toThrow();
    expect(renderEvidenceBundlesForPrompt(undefined as unknown as SkillCandidateEvidenceBundle[])).toBe('### Candidate Evidence Bundles (0)');
  });
});
