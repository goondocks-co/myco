import { describe, it, expect } from 'vitest';
import { stripReasoningTokens, extractJson } from '@myco/intelligence/response';

describe('stripReasoningTokens', () => {
  it('strips <think>...</think> tags (DeepSeek pattern)', () => {
    const input = '<think>\nLet me think about this carefully.\n</think>\nThe answer is 42.';
    expect(stripReasoningTokens(input)).toBe('The answer is 42.');
  });

  it('strips implicit </think> (GLM pattern: text starts mid-thinking, ends with </think>)', () => {
    const input = 'I am reasoning through this...\n</think>\nFinal answer here.';
    expect(stripReasoningTokens(input)).toBe('Final answer here.');
  });

  it('strips <reasoning>...</reasoning> tags', () => {
    const input = '<reasoning>\nThis is my chain of thought.\n</reasoning>\nConclusion reached.';
    expect(stripReasoningTokens(input)).toBe('Conclusion reached.');
  });

  it('strips <|thinking|>...<|/thinking|> tags', () => {
    const input = '<|thinking|>\nStep 1: consider options.\nStep 2: decide.\n<|/thinking|>\nResult: option A.';
    expect(stripReasoningTokens(input)).toBe('Result: option A.');
  });

  it('strips "Thinking Process:" plain text block followed by ## heading (Qwen 3.5 pattern)', () => {
    const input = 'Thinking Process:\n1. Consider the request.\n2. Formulate a response.\n\n## Answer\nHere is the answer.';
    const result = stripReasoningTokens(input);
    expect(result).toContain('## Answer');
    expect(result).not.toContain('Thinking Process:');
  });

  it('returns original text when no reasoning tokens present', () => {
    const input = 'This is a plain response with no reasoning tags.';
    expect(stripReasoningTokens(input)).toBe(input);
  });

  it('returns empty string for empty input', () => {
    expect(stripReasoningTokens('')).toBe('');
  });

  it('handles multiline think blocks with nested content', () => {
    const input = '<think>\nLet me consider:\n- point A\n- point B\n\nFinal thought.\n</think>\nDone.';
    expect(stripReasoningTokens(input)).toBe('Done.');
  });
});

describe('extractJson', () => {
  it('extracts JSON from ```json fences', () => {
    const input = 'Here is the result:\n```json\n{"key": "value", "count": 3}\n```\nDone.';
    const result = extractJson(input) as Record<string, unknown>;
    expect(result.key).toBe('value');
    expect(result.count).toBe(3);
  });

  it('extracts JSON from plain ``` fences without language tag', () => {
    const input = '```\n{"type": "spore"}\n```';
    const result = extractJson(input) as Record<string, unknown>;
    expect(result.type).toBe('spore');
  });

  it('extracts bare JSON object without fences', () => {
    const input = 'Some preamble text.\n{"observation": "found bug", "severity": 2}\nSome trailing text.';
    const result = extractJson(input) as Record<string, unknown>;
    expect(result.observation).toBe('found bug');
    expect(result.severity).toBe(2);
  });

  it('strips reasoning tokens before extracting JSON', () => {
    const input = '<think>\nLet me format the output.\n</think>\n```json\n{"type": "decision"}\n```';
    const result = extractJson(input) as Record<string, unknown>;
    expect(result.type).toBe('decision');
  });

  it('handles malformed JSON gracefully by throwing a SyntaxError', () => {
    const input = '{"broken": json here}';
    expect(() => extractJson(input)).toThrow(SyntaxError);
  });

  it('extracts JSON with nested objects', () => {
    const input = '```json\n{"outer": {"inner": true, "count": 5}}\n```';
    const result = extractJson(input) as Record<string, Record<string, unknown>>;
    expect(result.outer.inner).toBe(true);
    expect(result.outer.count).toBe(5);
  });

  it('extracts JSON array from fences', () => {
    const input = '```json\n[1, 2, 3]\n```';
    const result = extractJson(input) as number[];
    expect(result).toEqual([1, 2, 3]);
  });
});
