/**
 * A dispatch's parameters reach the task prompt: `session_id` from the
 * parameters wins over one found in the instruction, and any other parameter
 * fills its own placeholder.
 */
import { describe, expect, it } from 'bun:test';
import { composeTaskPrompt } from '@myco/agent/prompt-composition.js';

const base = { vaultContext: '', taskDisplayName: 'Title & Summary', taskPrompt: 'Target session: {{session_id}}\nMode: {{mode}}\nNote: {{instruction}}' };

describe('composeTaskPrompt with dispatch parameters', () => {
  it('takes the session id from the parameters ahead of the instruction', () => {
    const prompt = composeTaskPrompt({ ...base, instruction: 'retitle 11111111-2222-4333-8444-555555555555', params: { session_id: 'sess_dispatched', mode: 'owner' } });
    expect(prompt).toContain('Target session: sess_dispatched');
    expect(prompt).toContain('Mode: owner');
    expect(prompt).toContain('Note: retitle 11111111-2222-4333-8444-555555555555');
  });

  it('still reads the session id from the instruction when no parameters name one', () => {
    const prompt = composeTaskPrompt({ ...base, instruction: 'retitle 11111111-2222-4333-8444-555555555555' });
    expect(prompt).toContain('Target session: 11111111-2222-4333-8444-555555555555');
    expect(prompt).toContain('Mode: {{mode}}');
  });

  it('leaves the session empty with neither, as a local automatic run reads it', () => {
    expect(composeTaskPrompt(base)).toContain('Target session: \n');
  });
});
