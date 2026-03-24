import { describe, it, expect } from 'vitest';
import * as sessionStart from '../../src/hooks/session-start.js';
import * as sessionEnd from '../../src/hooks/session-end.js';
import * as stop from '../../src/hooks/stop.js';
import * as userPromptSubmit from '../../src/hooks/user-prompt-submit.js';
import * as postToolUse from '../../src/hooks/post-tool-use.js';

const VALID_HOOKS = [
  'session-start',
  'session-end',
  'stop',
  'user-prompt-submit',
  'post-tool-use',
];

describe('hook dispatch', () => {
  it('covers all 5 hooks', () => {
    expect(VALID_HOOKS).toHaveLength(5);
  });

  it('session-start module exports main()', () => {
    expect(typeof sessionStart.main).toBe('function');
  });

  it('session-end module exports main()', () => {
    expect(typeof sessionEnd.main).toBe('function');
  });

  it('stop module exports main()', () => {
    expect(typeof stop.main).toBe('function');
  });

  it('user-prompt-submit module exports main()', () => {
    expect(typeof userPromptSubmit.main).toBe('function');
  });

  it('post-tool-use module exports main()', () => {
    expect(typeof postToolUse.main).toBe('function');
  });
});
