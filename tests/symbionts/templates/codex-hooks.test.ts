import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TEMPLATES_DIR = path.join(import.meta.dirname, '../../../packages/myco/src/symbionts/templates');

describe('codex hooks.json template', () => {
  const tplPath = path.join(TEMPLATES_DIR, 'codex', 'hooks.json');
  const tpl = JSON.parse(readFileSync(tplPath, 'utf8')) as Record<string, unknown>;

  it('registers PreToolUse alongside the existing lifecycle events', () => {
    expect(Array.isArray(tpl.PreToolUse)).toBe(true);
    expect(Array.isArray(tpl.SessionStart)).toBe(true);
    expect(Array.isArray(tpl.UserPromptSubmit)).toBe(true);
    expect(Array.isArray(tpl.PostToolUse)).toBe(true);
  });

  it('PreToolUse invokes the pre-tool-use hook with the codex symbiont flag', () => {
    const groups = tpl.PreToolUse as Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    expect(groups).toHaveLength(1);
    const handler = groups[0].hooks[0];
    expect(handler.type).toBe('command');
    expect(handler.command).toContain('hook pre-tool-use');
    expect(handler.command).toContain('--symbiont codex');
    expect(handler.command).toContain('myco-run.cjs');
  });

  it('PreToolUse timeout is short (hot path)', () => {
    const groups = tpl.PreToolUse as Array<{ hooks: Array<{ timeout?: number }> }>;
    const t = groups[0].hooks[0].timeout;
    expect(typeof t).toBe('number');
    expect(t).toBeLessThanOrEqual(5);
  });

  it('does not bake a matcher into PreToolUse (handler resolves via manifest)', () => {
    const groups = tpl.PreToolUse as Array<Record<string, unknown>>;
    // matcher field should be absent (or empty string, matching Claude convention)
    expect('matcher' in groups[0] ? (groups[0].matcher as string) : '').toBe('');
  });
});
