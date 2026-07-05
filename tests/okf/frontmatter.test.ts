import { describe, expect, it } from 'bun:test';
import { OkfFrontmatterError, parseConceptDoc, serializeConceptDoc } from '@myco/okf/frontmatter.js';

describe('parseConceptDoc', () => {
  it('parses a minimal document', () => {
    expect(parseConceptDoc('---\ntype: Note\n---\nBody')).toEqual({
      frontmatter: { type: 'Note' },
      body: 'Body',
    });
  });

  it('parses a document with a blank separator line and trailing newline', () => {
    expect(parseConceptDoc('---\ntype: Note\n---\n\nBody\n')).toEqual({
      frontmatter: { type: 'Note' },
      body: 'Body',
    });
  });

  it('parses an empty body', () => {
    expect(parseConceptDoc('---\ntype: Note\n---\n')).toEqual({
      frontmatter: { type: 'Note' },
      body: '',
    });
  });

  it('normalizes CRLF endings', () => {
    expect(parseConceptDoc('---\r\ntype: Note\r\n---\r\nBody\r\n')).toEqual({
      frontmatter: { type: 'Note' },
      body: 'Body',
    });
  });

  it('throws when the frontmatter block is missing', () => {
    expect(() => parseConceptDoc('just a body')).toThrow(OkfFrontmatterError);
    expect(() => parseConceptDoc('just a body')).toThrow(/missing_frontmatter/);
  });

  it('throws when the frontmatter block is unterminated', () => {
    expect(() => parseConceptDoc('---\ntype: Note\nBody')).toThrow(/missing_frontmatter/);
  });

  it('throws on unparseable YAML', () => {
    expect(() => parseConceptDoc('---\ntype: [unclosed\n---\nBody')).toThrow(OkfFrontmatterError);
    expect(() => parseConceptDoc('---\ntype: [unclosed\n---\nBody')).toThrow(/unparseable_frontmatter/);
  });

  it('throws on non-mapping frontmatter', () => {
    expect(() => parseConceptDoc('---\n- a\n- b\n---\nBody')).toThrow(/must be a YAML mapping/);
  });

  it('throws on duplicate keys', () => {
    expect(() => parseConceptDoc('---\ntype: A\ntype: B\n---\nBody')).toThrow(/unparseable_frontmatter/);
  });

  it('throws on an alias bomb', () => {
    const bomb = `a: &a [1, 2]\nb: [${Array(80).fill('*a').join(', ')}]`;
    expect(() => parseConceptDoc(`---\n${bomb}\n---\nBody`)).toThrow(/unparseable_frontmatter/);
  });

  it('throws on nesting deeper than 6 containers', () => {
    const deep = 'a:\n  b:\n    c:\n      d:\n        e:\n          f:\n            g: 1';
    expect(() => parseConceptDoc(`---\ntype: Note\n${deep}\n---\nBody`)).toThrow(/nesting_too_deep/);
  });

  it('accepts nesting of exactly 6 containers', () => {
    const ok = 'a:\n  b:\n    c:\n      d:\n        e:\n          f: 1';
    expect(parseConceptDoc(`---\ntype: Note\n${ok}\n---\nBody`).frontmatter.type).toBe('Note');
  });

  it('throws on an oversized scalar', () => {
    const big = 'x'.repeat(8 * 1024 + 1);
    expect(() => parseConceptDoc(`---\ntype: Note\nbig: ${big}\n---\nBody`)).toThrow(/scalar_too_large/);
  });

  it('throws on an oversized array', () => {
    const arr = `[${Array(513).fill('1').join(', ')}]`;
    expect(() => parseConceptDoc(`---\ntype: Note\nbig: ${arr}\n---\nBody`)).toThrow(/array_too_long/);
  });

  it('throws on oversized frontmatter', () => {
    // Many small keys so no single scalar bound trips first.
    const lines = Array.from({ length: 5000 }, (_, i) => `k${i}: ${'v'.repeat(8)}`).join('\n');
    expect(() => parseConceptDoc(`---\n${lines}\n---\nBody`)).toThrow(/frontmatter_too_large/);
  });

  it('throws on an oversized body', () => {
    const body = 'x'.repeat(1024 * 1024 + 1);
    expect(() => parseConceptDoc(`---\ntype: Note\n---\n${body}`)).toThrow(/body_too_large/);
  });
});

describe('serializeConceptDoc', () => {
  it('emits canonical form with LF endings and one trailing newline', () => {
    expect(serializeConceptDoc({ type: 'Note' }, 'Body')).toBe('---\ntype: Note\n---\n\nBody\n');
  });

  it('emits no body section for an empty body', () => {
    expect(serializeConceptDoc({ type: 'Note' }, '')).toBe('---\ntype: Note\n---\n');
  });

  it('orders known keys canonically and preserves insertion order for the rest', () => {
    const out = serializeConceptDoc(
      { zeta: 1, timestamp: '2026-07-05', alpha: 2, title: 'T', type: 'Note' },
      'Body',
    );
    const keys = out
      .split('---\n')[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(':')[0]);
    expect(keys).toEqual(['type', 'title', 'timestamp', 'zeta', 'alpha']);
  });

  it('preserves caller key order verbatim with keyOrder: insertion', () => {
    const out = serializeConceptDoc({ okf_version: '0.1', type: 'Bundle' }, '', { keyOrder: 'insertion' });
    expect(out).toBe('---\nokf_version: "0.1"\ntype: Bundle\n---\n');
  });

  it('round-trips keys that shadow Object.prototype members', () => {
    const raw = '---\ntype: Note\ntoString: keepme\nconstructor: alsome\nvalueOf: three\nhasOwnProperty: four\n---\nBody';
    const parsed = parseConceptDoc(raw);
    expect(Object.keys(parsed.frontmatter)).toEqual([
      'type',
      'toString',
      'constructor',
      'valueOf',
      'hasOwnProperty',
    ]);
    const reparsed = parseConceptDoc(serializeConceptDoc(parsed.frontmatter, parsed.body));
    expect(reparsed.frontmatter).toEqual({
      type: 'Note',
      toString: 'keepme',
      constructor: 'alsome',
      valueOf: 'three',
      hasOwnProperty: 'four',
    });
  });

  it('round-trips a __proto__ key as ordinary data', () => {
    const parsed = parseConceptDoc('---\ntype: Note\n__proto__: kept\n---\nBody');
    const reparsed = parseConceptDoc(serializeConceptDoc(parsed.frontmatter, parsed.body));
    expect(Object.keys(reparsed.frontmatter)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(reparsed.frontmatter, '__proto__')?.value).toBe('kept');
  });

  it('round-trips unknown keys and values deep-equal through parse → serialize → parse', () => {
    const frontmatter = {
      type: 'Note',
      x_vendor: { a: [1, 2], nested: { flag: true, name: 'v' } },
      x_list: ['one', 'two'],
    };
    const first = parseConceptDoc(serializeConceptDoc(frontmatter, 'Body'));
    const second = parseConceptDoc(serializeConceptDoc(first.frontmatter, first.body));
    expect(second.frontmatter).toEqual(frontmatter);
    expect(second.body).toBe('Body');
  });

  it('is byte-idempotent for canonical input', () => {
    const once = serializeConceptDoc(
      { type: 'Note', title: 'T', x_vendor: { a: [1, 2] } },
      'Body line one\n\nBody line two',
    );
    const parsed = parseConceptDoc(once);
    expect(serializeConceptDoc(parsed.frontmatter, parsed.body)).toBe(once);
  });

  it('is deterministic — identical inputs produce identical bytes', () => {
    const fm = { type: 'Note', tags: ['a', 'b'], title: 'T' };
    expect(serializeConceptDoc(fm, 'Body')).toBe(serializeConceptDoc({ ...fm }, 'Body'));
  });

  it('enforces the same value bounds as parse', () => {
    expect(() => serializeConceptDoc({ type: 'Note', big: 'x'.repeat(8 * 1024 + 1) }, 'Body')).toThrow(
      /scalar_too_large/,
    );
  });
});
