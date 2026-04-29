import { describe, it, expect } from 'bun:test';
import { interpolateArgs } from '@myco/utils/interpolate-args.js';

describe('interpolateArgs', () => {
  it('substitutes simple {{ key }} placeholders against vars', () => {
    const result = interpolateArgs(
      { name: '{{ user.name }}', count: '{{ params.n }}' },
      { user: { name: 'alice' }, params: { n: 5 } },
    );
    expect(result).toEqual({ name: 'alice', count: 5 });
  });

  it('elides args whose template renders to null or undefined', () => {
    const result = interpolateArgs(
      { id: '{{ params.id | default(null) }}', limit: '{{ params.limit | default(10) }}' },
      { params: {} },
    );
    expect(result).toEqual({ limit: 10 });
    expect(result).not.toHaveProperty('id');
  });

  it('preserves literal non-template values', () => {
    const result = interpolateArgs(
      { mode: 'strict', limit: 5, enabled: true },
      {},
    );
    expect(result).toEqual({ mode: 'strict', limit: 5, enabled: true });
  });

  it('preserves arrays and objects from var lookup', () => {
    const result = interpolateArgs(
      { tags: '{{ item.tags }}' },
      { item: { tags: ['a', 'b'] } },
    );
    expect(result).toEqual({ tags: ['a', 'b'] });
  });

  it('throws on unresolved var when no default is given', () => {
    expect(() =>
      interpolateArgs({ id: '{{ params.missing }}' }, { params: {} }),
    ).toThrow(/unresolved/i);
  });

  it('coerces numeric default values correctly', () => {
    const result = interpolateArgs(
      { limit: '{{ params.limit | default(42) }}' },
      { params: {} },
    );
    expect(result).toEqual({ limit: 42 });
  });
});
