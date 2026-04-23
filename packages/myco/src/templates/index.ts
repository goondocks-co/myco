/**
 * Template loader for package-owned markdown assets such as `_portal.md`.
 *
 * These templates are bundled into code at build time so the compiled Bun
 * binary never depends on runtime filesystem reads under /$bunfs/.
 */

import { BUNDLED_MARKDOWN_TEMPLATES } from '../static-assets.generated.js';
import { interpolate } from '../utils/interpolate.js';

const templateCache = new Map<string, string>();

/** Load a template by name (without .md extension) and interpolate {{variables}}. */
export function loadTemplate(name: string, vars: Record<string, string> = {}): string {
  let raw = templateCache.get(name);
  if (!raw) {
    raw = BUNDLED_MARKDOWN_TEMPLATES[name];
    if (raw === undefined) {
      throw new Error(`Unknown template: ${name}`);
    }
    templateCache.set(name, raw);
  }
  return interpolate(raw, vars);
}
