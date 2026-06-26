import { describe, expect, test } from 'bun:test';
import { classifyHarnessErrorKind } from '@myco/agent/harness/openai.js';

describe('classifyHarnessErrorKind', () => {
  test('connection error → connection', () => {
    expect(classifyHarnessErrorKind('Was there a typo in the url or port?', undefined)).toBe('connection');
  });
  test('max turns → max-turns', () => {
    expect(classifyHarnessErrorKind('Max turns exceeded', 'MaxTurnsExceededError')).toBe('max-turns');
  });
  test('other → other', () => {
    expect(classifyHarnessErrorKind('sink_response_unparseable', undefined)).toBe('other');
  });
});
