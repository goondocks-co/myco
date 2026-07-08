import { describe, expect, test } from 'bun:test';
import { AgentTaskSchema, PhaseDefinitionSchema } from '@myco/agent/schemas.js';

/**
 * Coverage for the authored `purpose` field on PhaseDefinitionSchema. The
 * field feeds the semantic-check classifier's phasePurpose.promptExcerpt
 * (see write-classifier.ts) as an alternative to the first-500-chars-of-
 * prompt fallback — it must stay optional and bounded so a pasted whole
 * prompt fails validation instead of silently becoming the "purpose".
 */
describe('PhaseDefinitionSchema purpose field', () => {
  const basePhase = {
    name: 'extract',
    prompt: 'Extract structured data from the source document.',
    tools: [],
    maxTurns: 10,
    required: true,
  };

  test('accepts a phase without purpose (field is optional)', () => {
    const result = PhaseDefinitionSchema.safeParse(basePhase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBeUndefined();
    }
  });

  test('accepts and round-trips a valid purpose string', () => {
    const purpose = 'Writes the finalized report to vault_reports. Never touches vault_sessions.';
    const result = PhaseDefinitionSchema.safeParse({ ...basePhase, purpose });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBe(purpose);
    }
  });

  test('rejects an empty string purpose', () => {
    const result = PhaseDefinitionSchema.safeParse({ ...basePhase, purpose: '' });
    expect(result.success).toBe(false);
  });

  test('rejects a purpose longer than 2000 characters', () => {
    const result = PhaseDefinitionSchema.safeParse({ ...basePhase, purpose: 'x'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  test('accepts a purpose exactly at the 2000 character bound', () => {
    const result = PhaseDefinitionSchema.safeParse({ ...basePhase, purpose: 'x'.repeat(2000) });
    expect(result.success).toBe(true);
  });

  test('task-YAML load path (AgentTaskSchema) is unaffected by the new field', () => {
    const task = {
      name: 'sample-task',
      displayName: 'Sample Task',
      description: 'A sample task for schema testing.',
      agent: 'claude-code',
      prompt: 'Do the thing.',
      isDefault: false,
      phases: [basePhase, { ...basePhase, name: 'write', purpose: 'Writes results to vault_notes only.' }],
    };
    const result = AgentTaskSchema.safeParse(task);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phases?.[0]?.purpose).toBeUndefined();
      expect(result.data.phases?.[1]?.purpose).toBe('Writes results to vault_notes only.');
    }
  });
});
