/**
 * Template loader — reads .md templates from disk and interpolates variables.
 * Templates are markdown files in this directory, shipped to dist/src/templates/.
 * Used for vault files that the daemon writes (e.g., _portal.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the templates directory. Same strategy as prompts loader:
 * walk up from the current file to find package.json, then use dist/src/templates/.
 */
function resolveTemplatesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'dist', 'src', 'templates');
    }
    if (fs.existsSync(path.join(dir, 'portal.md'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(fileURLToPath(import.meta.url));
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
