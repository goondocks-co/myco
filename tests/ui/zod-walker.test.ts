// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { walkSchemaFields } from '../../packages/myco/ui/src/settings/zod-walker';

describe('walkSchemaFields', () => {
  it('yields a boolean leaf as toggle', () => {
    const schema = z.object({ enabled: z.boolean() });
    expect(walkSchemaFields(schema)).toEqual([
      { key: 'enabled', kind: 'toggle', optional: false },
    ]);
  });

  it('yields an enum leaf as select with options', () => {
    const schema = z.object({ mode: z.enum(['dark', 'light']) });
    expect(walkSchemaFields(schema)).toEqual([
      { key: 'mode', kind: 'select', optional: false, options: ['dark', 'light'] },
    ]);
  });

  it('yields a number leaf with min/max', () => {
    const schema = z.object({ count: z.number().int().min(1).max(100) });
    const got = walkSchemaFields(schema)[0];
    expect(got).toEqual(
      expect.objectContaining({ key: 'count', kind: 'number', min: 1, max: 100 }),
    );
  });

  it('yields a string leaf as text', () => {
    const schema = z.object({ name: z.string() });
    expect(walkSchemaFields(schema)[0]).toEqual(
      expect.objectContaining({ key: 'name', kind: 'text' }),
    );
  });

  it('yields an array of strings as list', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    expect(walkSchemaFields(schema)[0]).toEqual(
      expect.objectContaining({ key: 'tags', kind: 'list' }),
    );
  });

  it('recurses into nested objects with dotted keys', () => {
    const schema = z.object({
      provider: z.object({ name: z.string(), context_length: z.number() }),
    });
    const keys = walkSchemaFields(schema).map((f) => f.key);
    expect(keys).toEqual(['provider.name', 'provider.context_length']);
  });

  it('unwraps optional and default to surface the inner kind', () => {
    const schema = z.object({
      note: z.string().optional(),
      retries: z.number().default(3),
    });
    const got = walkSchemaFields(schema);
    expect(got).toEqual([
      expect.objectContaining({ key: 'note', kind: 'text', optional: true }),
      expect.objectContaining({ key: 'retries', kind: 'number', optional: false }),
    ]);
  });

  it('descends through ZodPipe (.pipe()) to the output object', () => {
    // Mirrors `rejectLegacyRuntimeKey` in packages/myco/src/config/schema.ts —
    // a guard `.pipe()`d into the real validator. The walker should ignore
    // the guard and surface the object's fields.
    const piped = z.unknown().superRefine(() => {}).pipe(
      z.object({ enabled: z.boolean(), model: z.string() }),
    );
    const keys = walkSchemaFields(piped).map((f) => f.key);
    expect(keys).toEqual(['enabled', 'model']);
  });

  it('descends through z.preprocess to the inner object', () => {
    // Mirrors MachineConfigSchema — a preprocess that strips legacy fields
    // before strict validation. The walker should reach the strict object.
    const schema = z.preprocess(
      (raw) => raw,
      z.object({ daemon: z.object({ log_level: z.string() }) }).strict(),
    );
    const keys = walkSchemaFields(schema).map((f) => f.key);
    expect(keys).toEqual(['daemon.log_level']);
  });

  it('unwraps ZodReadonly to surface the inner object', () => {
    const schema = z.object({ tags: z.array(z.string()) }).readonly();
    const keys = walkSchemaFields(schema).map((f) => f.key);
    expect(keys).toEqual(['tags']);
  });
});
