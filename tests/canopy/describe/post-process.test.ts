import { describe, it, expect } from 'bun:test';
import { postProcess } from '@myco/canopy/describe/post-process';

const CAP = 180;

describe('postProcess — happy path', () => {
  it('returns a clean sentence unchanged when within cap', () => {
    const input = 'Aggregates per-session canopy injection outcomes from persisted activity rows via a single SQL self-join.';
    expect(postProcess(input, CAP, [])).toBe(input);
  });

  it('collapses newlines and runs of whitespace', () => {
    const input = 'Aggregates per-session\n\n  canopy   outcomes  via SQL.';
    expect(postProcess(input, CAP, [])).toBe('Aggregates per-session canopy outcomes via SQL.');
  });

  it('strips wrapping straight double quotes', () => {
    expect(postProcess('"Builds the prompt template."', CAP, [])).toBe('Builds the prompt template.');
  });

  it('strips wrapping curly quotes', () => {
    expect(postProcess('“Builds the prompt template.”', CAP, [])).toBe('Builds the prompt template.');
  });

  it('preserves inner straight quotes when wrapping is unbalanced', () => {
    const input = 'Reads the "manifest" file and returns its parsed shape.';
    expect(postProcess(input, CAP, [])).toBe(input);
  });
});

describe('postProcess — boilerplate stripping', () => {
  it('strips a leading "Here is a "', () => {
    const input = 'Here is a one-sentence summary: Loads the prompt template.';
    // First the "Here is a " prefix is stripped, then the "summary: " prefix
    // (because the loop re-runs while changes happen).
    expect(postProcess(input, CAP, [])).toBe('one-sentence summary: Loads the prompt template.');
  });

  it('strips a leading "This file "', () => {
    expect(postProcess('This file builds the prompt template.', CAP, [])).toBe('builds the prompt template.');
  });

  it('strips a leading "The module "', () => {
    expect(postProcess('The module builds prompts.', CAP, [])).toBe('builds prompts.');
  });

  it('strips a leading "Summary: "', () => {
    expect(postProcess('Summary: Builds the prompt template.', CAP, [])).toBe('Builds the prompt template.');
  });

  it('strips a leading "Description: "', () => {
    expect(postProcess('Description: Builds the prompt template.', CAP, [])).toBe('Builds the prompt template.');
  });

  it('strips both "Here is" and "Summary:" when nested', () => {
    expect(postProcess('Here is a summary: Builds prompts.', CAP, [])).toBe('Builds prompts.');
  });

  it('returns null when stripping leaves nothing', () => {
    expect(postProcess('Summary: ', CAP, [])).toBeNull();
  });
});

describe('postProcess — refusal rejection', () => {
  it('rejects "I cannot" anywhere', () => {
    expect(postProcess('I cannot summarize this file without more context.', CAP, [])).toBeNull();
  });

  it('rejects "I am sorry"', () => {
    expect(postProcess('I am sorry, but this file appears empty.', CAP, [])).toBeNull();
  });

  it('rejects "I\'m sorry"', () => {
    expect(postProcess("I'm sorry — I can't help with that.", CAP, [])).toBeNull();
  });

  it('rejects "as an AI" anywhere', () => {
    expect(postProcess('As an AI language model, I cannot reliably summarize.', CAP, [])).toBeNull();
  });
});

describe('postProcess — exports-verbatim rejection', () => {
  it('rejects when output matches one of the exports exactly', () => {
    expect(postProcess('handleSessionStart', CAP, ['handleSessionStart', 'SessionStartPayload'])).toBeNull();
  });

  it('does not reject when output merely contains an export name', () => {
    const input = 'Defines handleSessionStart, the entry point for the SessionStart hook.';
    expect(postProcess(input, CAP, ['handleSessionStart'])).toBe(input);
  });

  it('preserves case sensitivity — case mismatch is allowed', () => {
    // The model returned a different-cased identifier-shaped phrase; not
    // a perfect regurgitation, so we keep it.
    const out = postProcess('handlesessionstart', CAP, ['handleSessionStart']);
    expect(out).toBe('handlesessionstart');
  });
});

describe('postProcess — truncation', () => {
  it('caps at maxChars exactly', () => {
    const input = 'a'.repeat(300);
    expect(postProcess(input, CAP, [])).toHaveLength(CAP);
  });

  it('does not truncate when under the cap', () => {
    const input = 'a'.repeat(50);
    expect(postProcess(input, CAP, [])).toHaveLength(50);
  });

  it('honors a custom cap', () => {
    expect(postProcess('Builds the prompt template for canopy-describe.', 10, [])).toBe('Builds the');
  });
});

describe('postProcess — empty/whitespace inputs', () => {
  it('returns null for the empty string', () => {
    expect(postProcess('', CAP, [])).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(postProcess('   \n\n  \t  ', CAP, [])).toBeNull();
  });
});
