// tests/agent/skill-edit.test.ts
import { describe, it, expect } from 'bun:test';
import { applySkillEdits } from '../../packages/myco/src/agent/tools/skill-edit.js';

describe('applySkillEdits', () => {
  it('applies a single unique edit', () => {
    expect(applySkillEdits('alpha beta gamma', [{ old_string: 'beta', new_string: 'BETA' }]))
      .toEqual({ ok: true, content: 'alpha BETA gamma' });
  });
  it('applies edits sequentially', () => {
    expect(applySkillEdits('one two', [
      { old_string: 'one', new_string: 'three' },
      { old_string: 'three two', new_string: 'done' },
    ])).toEqual({ ok: true, content: 'done' });
  });
  it('treats new_string literally — does NOT interpret $ replacement patterns', () => {
    // MUST-FIX M1: String.prototype.replace interprets $$, $&, $`, $' in the
    // replacement even with a string search. Skill bodies contain `$$`/`$'…'`.
    const r = applySkillEdits('PID is HERE', [{ old_string: 'HERE', new_string: '$$ and $& and $`' }]);
    expect(r).toEqual({ ok: true, content: 'PID is $$ and $& and $`' });
  });
  it('rejects when old_string is not found', () => {
    const r = applySkillEdits('alpha', [{ old_string: 'missing', new_string: 'x' }]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/edit 1:.*not found/i);
  });
  it('rejects multi-match without replace_all', () => {
    const r = applySkillEdits('x x x', [{ old_string: 'x', new_string: 'y' }]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/edit 1:.*matches 3 times/i);
  });
  it('replace_all replaces every occurrence (literally)', () => {
    expect(applySkillEdits('x x x', [{ old_string: 'x', new_string: 'y', replace_all: true }]))
      .toEqual({ ok: true, content: 'y y y' });
  });
  it('rejects empty old_string', () => {
    const r = applySkillEdits('alpha', [{ old_string: '', new_string: 'x' }]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/edit 1:.*non-empty|empty/i);
  });
  it('rejects empty edit list', () => {
    const r = applySkillEdits('alpha', []);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toMatch(/no edits/i);
  });
});
