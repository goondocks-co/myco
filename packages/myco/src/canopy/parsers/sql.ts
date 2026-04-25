import type { CanopyParser } from '../types.js';
import { fallbackParser } from './fallback.js';

// Real implementation lands in Task A.3.
export const sqlParser: CanopyParser = (input) => ({
  ...fallbackParser(input),
  language: 'sql',
});
