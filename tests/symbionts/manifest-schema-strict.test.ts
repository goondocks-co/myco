import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'bun:test';
import yaml from 'yaml';

import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { SEMANTIC_FIELDS } from '@myco/hooks/response.js';

/**
 * The manifest root refuses an undeclared key.
 *
 * A key in the wrong place is indistinguishable from a typo: written one level
 * out, `hookResponse` parses clean, is dropped, and configures nothing. The
 * only symptom is the behaviour never arriving — no error, no warning, and a
 * plugin reading plain text where it expected JSON. Strict parsing turns the
 * whole class into a codegen failure that names the offending key.
 */

const MANIFESTS_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  '../../packages/myco/src/symbionts/manifests',
);

const manifestFiles = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.yaml'));

describe('manifest schema strictness', () => {
  it('enumerates the shipped manifests', () => {
    expect(manifestFiles.length).toBeGreaterThan(0);
  });

  for (const file of manifestFiles) {
    it(`${file} declares only keys the schema knows`, () => {
      const raw = yaml.parse(fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf-8'));
      const parsed = SymbiontManifestSchema.safeParse(raw);
      const unknown = parsed.success
        ? []
        : parsed.error.issues.filter((i) => i.code === 'unrecognized_keys').flatMap((i) => (i as { keys: string[] }).keys);
      expect({ file, unknown }).toEqual({ file, unknown: [] });
      expect({ file, ok: parsed.success }).toEqual({ file, ok: true });
    });
  }

  it('parses the generated bundle strictly, so the build output holds no key the source may not', () => {
    for (const manifest of BUNDLED_MANIFESTS) {
      const parsed = SymbiontManifestSchema.safeParse(manifest);
      expect({ name: manifest.name, ok: parsed.success }).toEqual({ name: manifest.name, ok: true });
    }
  });

  /**
   * The negative case, and the one this gate was written for: a real key at
   * the wrong depth. Before strictness this parsed clean and the symbiont
   * silently kept the default response format.
   */
  it('refuses a known key written at the wrong depth, naming it', () => {
    const raw = yaml.parse(fs.readFileSync(path.join(MANIFESTS_DIR, 'pi.yaml'), 'utf-8')) as Record<string, unknown>;
    const misplaced = { ...raw, hookResponse: { format: 'json', fieldNames: { additionalContext: 'additionalContext' } } };

    const parsed = SymbiontManifestSchema.safeParse(misplaced);
    expect(parsed.success).toBe(false);
    const named = parsed.success
      ? []
      : parsed.error.issues.filter((i) => i.code === 'unrecognized_keys').flatMap((i) => (i as { keys: string[] }).keys);
    expect(named).toContain('hookResponse');
  });

  it('refuses a key nothing declares anywhere', () => {
    const raw = yaml.parse(fs.readFileSync(path.join(MANIFESTS_DIR, 'pi.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(SymbiontManifestSchema.safeParse({ ...raw, notAKey: true }).success).toBe(false);
  });
});

/**
 * A `hookResponse.fieldNames` key names a field of the hook response. The
 * schema types it as a record of strings, so a typo is accepted, maps nothing,
 * and the field it was meant to carry simply never reaches the symbiont —
 * which for `promptId` means every transcript line written without an id.
 */
describe('hook response field mappings', () => {
  it('maps only fields the hook response declares', () => {
    const known = new Set<string>(SEMANTIC_FIELDS);
    for (const manifest of BUNDLED_MANIFESTS) {
      const fieldNames = manifest.registration?.hookResponse?.fieldNames ?? {};
      const unknown = Object.keys(fieldNames).filter((key) => !known.has(key));
      expect({ name: manifest.name, unknown }).toEqual({ name: manifest.name, unknown: [] });
    }
  });
});
