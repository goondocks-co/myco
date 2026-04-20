import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('Pi plugin', () => {
  it('plugin source file exists', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  it('plugin contains turn_start handler', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    const source = fs.readFileSync(pluginPath, 'utf-8');
    expect(source).toContain('pi.on("turn_start"');
  });

  it('plugin contains turn_end handler', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    const source = fs.readFileSync(pluginPath, 'utf-8');
    expect(source).toContain('pi.on("turn_end"');
  });

  it('plugin contains queue_update handler', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    const source = fs.readFileSync(pluginPath, 'utf-8');
    expect(source).toContain('pi.on("queue_update"');
  });

  it('mycoPostUserPrompt accepts kind and parentPromptBatchId options', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    const source = fs.readFileSync(pluginPath, 'utf-8');
    expect(source).toContain('kind');
    expect(source).toContain('parentPromptBatchId');
    expect(source).toContain('parent_prompt_batch_id');
  });

  it('postEventWithBuffer returns daemon response', () => {
    const pluginPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../packages/myco/src/symbionts/templates/pi/plugin.ts',
    );
    const source = fs.readFileSync(pluginPath, 'utf-8');
    expect(source).toContain('return result.data');
    expect(source).toContain('isIgnoredResponse');
  });
});
