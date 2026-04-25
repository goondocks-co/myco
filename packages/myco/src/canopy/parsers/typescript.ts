import type { CanopyParser } from '../types.js';
import { fallbackParser } from './fallback.js';

// Real implementation lands in Task A.2; the registry references this slot
// from A.1 onward, so a no-op delegate keeps the surface stable.
export const typescriptParser: CanopyParser = (input) => ({
  ...fallbackParser(input),
  language: 'typescript',
});
