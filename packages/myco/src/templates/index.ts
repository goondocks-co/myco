/**
 * Template loader — reads .md templates from disk and interpolates variables.
 * Templates are markdown files in this directory, shipped to dist/src/templates/.
 * Used for vault files that the daemon writes (e.g., _portal.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../utils/find-package-root.js';

/**
 * Resolve the templates directory. Same strategy as prompts loader.
 */
function resolveTemplatesDir(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  // Check if we're already in the templates directory (tsc output or dev mode)
  if (fs.existsSync(path.join(scriptDir, 'portal.md'))) return scriptDir;

  // Walk up to package root, then use dist/src/templates/
  const root = findPackageRoot(scriptDir);
  if (root) return path.join(root, 'dist', 'src', 'templates');

  return scriptDir;
}

const TEMPLATES_DIR = resolveTemplatesDir();

const templateCache = new Map<string, string>();

/** Load a template by name (without .md extension) and interpolate {{variables}}. */
export function loadTemplate(name: string, vars: Record<string, string> = {}): string {
  let raw = templateCache.get(name);
  if (!raw) {
    raw = fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.md`), 'utf-8');
    templateCache.set(name, raw);
  }

  let result = raw;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
