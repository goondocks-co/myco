import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { loadTemplate } from '@myco/templates/index.js';
import { BUNDLED_MARKDOWN_TEMPLATES } from '@myco/static-assets.generated.js';

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '..', '..', 'packages/myco/src/templates');

describe('markdown templates', () => {
  it('bundles every package-owned markdown template file', () => {
    const files = fs.readdirSync(TEMPLATES_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.basename(file, '.md'))
      .sort();

    expect(Object.keys(BUNDLED_MARKDOWN_TEMPLATES).sort()).toEqual(files);
  });

  it('loads templates from the bundled asset map', () => {
    expect(loadTemplate('portal')).toBe(BUNDLED_MARKDOWN_TEMPLATES.portal);
  });
});
