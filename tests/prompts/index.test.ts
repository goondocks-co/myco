import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { loadPrompt } from '@myco/prompts/index.js';
import { BUNDLED_PROMPTS } from '@myco/static-assets.generated.js';

const PROMPTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'packages/myco/src/prompts');

describe('prompt assets', () => {
  it('bundles every package-owned prompt markdown file', () => {
    const files = fs.readdirSync(PROMPTS_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.basename(file, '.md'))
      .sort();

    expect(Object.keys(BUNDLED_PROMPTS).sort()).toEqual(files);
  });

  it('loads prompts from the bundled asset map', () => {
    expect(loadPrompt('summary')).toBe(BUNDLED_PROMPTS.summary.trim());
    expect(loadPrompt('summary')).toContain('{{content}}');
  });
});
