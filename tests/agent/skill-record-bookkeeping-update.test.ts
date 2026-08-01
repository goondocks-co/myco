/**
 * The deterministic bookkeeping predicate that keeps the semantic-check
 * classifier out of provably harmless vault_skill_records updates.
 *
 * Exists because the classifier is a per-call model judgment: in run
 * 9638588f it passed one and blocked two IDENTICAL watermark updates,
 * failing the whole skill-evolve run. The predicate must accept exactly
 * the bookkeeping shape and nothing more — every rejection here falls
 * through to classification, never to bypass.
 */
import { describe, expect, it } from 'bun:test';
import {
  isBookkeepingSkillRecordUpdate,
  SKILL_RECORD_BOOKKEEPING_KEYS,
} from '@myco/agent/tools/skill-tools.js';

const BOOKKEEPING_PROPS = '{"last_assessed_at": 1785552074, "knowledge_watermark": 1785552074, "last_classification": "CURRENT"}';

// The exact payload shape from live run 4c7d7571, which the first version
// of the key set failed to admit: generation watermark + fingerprint map
// alongside the timestamp keys.
const FULL_ASSESS_PROPS = '{"last_assessed_at": 1785553987, "knowledge_watermark": 1785553987, "last_classification": "CURRENT", "last_assessed_generation": 18, "file_fingerprints": {"SKILL.md": "abc123", "references/notes.md": "def456"}}';

describe('isBookkeepingSkillRecordUpdate', () => {
  it('accepts an update whose only mutation is bookkeeping properties', () => {
    expect(isBookkeepingSkillRecordUpdate({ action: 'update', id: 'skill_x', properties: BOOKKEEPING_PROPS })).toBe(true);
  });

  it('accepts the full assess payload: timestamps + classification + generation + fingerprint map (run 4c7d7571 shape)', () => {
    expect(isBookkeepingSkillRecordUpdate({ action: 'update', id: 'skill_x', properties: FULL_ASSESS_PROPS })).toBe(true);
  });

  it('accepts every documented bookkeeping key with a bookkeeping-shaped value', () => {
    for (const key of SKILL_RECORD_BOOKKEEPING_KEYS) {
      const value = key === 'file_fingerprints' ? { 'SKILL.md': 'abc123' } : 1785552074;
      expect(isBookkeepingSkillRecordUpdate({
        action: 'update',
        id: 'skill_x',
        properties: JSON.stringify({ [key]: value }),
      })).toBe(true);
    }
  });

  it.each([
    ['non-update action', { action: 'delete', id: 'skill_x', properties: BOOKKEEPING_PROPS }],
    ['status present', { action: 'update', id: 'skill_x', status: 'retired', properties: BOOKKEEPING_PROPS }],
    ['generation present', { action: 'update', id: 'skill_x', generation: 2, properties: BOOKKEEPING_PROPS }],
    ['source_ids present', { action: 'update', id: 'skill_x', source_ids: '[]', properties: BOOKKEEPING_PROPS }],
    ['description present', { action: 'update', id: 'skill_x', description: 'new', properties: BOOKKEEPING_PROPS }],
    ['missing properties', { action: 'update', id: 'skill_x' }],
    ['unparseable properties', { action: 'update', id: 'skill_x', properties: 'not json' }],
    ['properties is an array', { action: 'update', id: 'skill_x', properties: '[1]' }],
    ['empty properties object', { action: 'update', id: 'skill_x', properties: '{}' }],
    ['unknown property key', { action: 'update', id: 'skill_x', properties: '{"last_assessed_at": 1, "content": "overwrite"}' }],
    ['non-primitive property value', { action: 'update', id: 'skill_x', properties: '{"last_classification": {"nested": true}}' }],
    ['file_fingerprints as an array', { action: 'update', id: 'skill_x', properties: '{"file_fingerprints": ["abc123"]}' }],
    ['file_fingerprints with nested object values', { action: 'update', id: 'skill_x', properties: '{"file_fingerprints": {"SKILL.md": {"hash": "abc"}}}' }],
  ])('falls through to classification for %s', (_label, args) => {
    expect(isBookkeepingSkillRecordUpdate(args as Record<string, unknown>)).toBe(false);
  });
});
