import type { CanopyParser } from '../types.js';
import { fallbackParser } from './fallback.js';

// Real implementation lands in Task A.3.
export const yamlJsonParser: CanopyParser = (input) => ({
  ...fallbackParser(input),
  language: input.path.endsWith('.json') ? 'json' : 'yaml',
});
