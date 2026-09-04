/**
 * The task prose one hosted run receives.
 *
 * The container runs a task as a single query. A phased task therefore reaches
 * it flattened, and the ordering its author relied on has to survive as reading
 * order — a phase silently dropped here is guidance the model never sees, with
 * nothing in the run row to say so.
 */
import { describe, expect, it } from 'bun:test';
import { composeHostedPrompt } from '@myco/agent/prompt-composition.js';
import { loadAllTasks } from '@myco/agent/registry.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';

describe('the hosted prompt', () => {
  it('is the task prompt alone when the task declares no phases', () => {
    expect(composeHostedPrompt({ taskPrompt: 'do the thing' })).toBe('do the thing');
    expect(composeHostedPrompt({ taskPrompt: 'do the thing', phases: [] })).toBe('do the thing');
  });

  it('puts each phase under its own heading, in declaration order', () => {
    expect(composeHostedPrompt({
      taskPrompt: 'the whole job',
      phases: [{ name: 'research', prompt: 'gather' }, { name: 'author', prompt: 'write' }],
    })).toBe('the whole job\n\n## Phase: research\ngather\n\n## Phase: author\nwrite');
  });

  it('drops an empty task prompt rather than opening with a blank section', () => {
    expect(composeHostedPrompt({ taskPrompt: '  ', phases: [{ name: 'only', prompt: 'go' }] }))
      .toBe('## Phase: only\ngo');
  });

  it('composes the same prose for the same definition', () => {
    const input = { taskPrompt: 'a', phases: [{ name: 'p', prompt: 'b' }] };
    expect(composeHostedPrompt(input)).toBe(composeHostedPrompt(input));
  });

  it('carries every phase of the instructions task the Deployment serves', () => {
    const task = loadAllTasks(resolveDefinitionsDir()).get('cortex-instructions')!;
    const composed = composeHostedPrompt({ taskPrompt: task.prompt, phases: task.phases });
    for (const phase of task.phases ?? []) expect(composed).toContain(`## Phase: ${phase.name}`);
    expect(composed.indexOf('## Phase: research')).toBeLessThan(composed.indexOf('## Phase: author'));
  });
});
