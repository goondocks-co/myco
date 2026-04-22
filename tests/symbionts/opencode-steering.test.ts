import { describe, it, expect } from 'bun:test';
describe('OpenCode plugin kind tagging', () => {
  it('imports without error', async () => {
    const mod = await import('@myco/symbionts/templates/opencode/plugin.ts');
    expect(mod).toBeDefined();
  });
});
