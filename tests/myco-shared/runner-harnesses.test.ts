/**
 * The worker's harness facts, read from each manifest's `runner:` block (#1561), are the facts the code held before
 * they moved there: `tests/fixtures/runner-harnesses-before-manifests.json` is every table as it was at 6ab5bf21,
 * captured by running that code. A manifest edit that changes what a worker or the Deployment does fails here by name;
 * a deliberate change updates the fixture in the same commit, where review sees it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_CREDENTIALS, credentialEnvFor } from '@goondocks/myco-shared/harness-providers';
import { SECRET_SLOTS, SECRET_SLOT_NAMES, harnessesReading } from '@goondocks/myco-shared/secret-slots';
import { CONFIGURABLE_PROFILE_HARNESSES, HARNESS_ASKING, OFFERABLE_PROFILE_HARNESSES, PROFILE_HARNESSES, profileModelMatches } from '@goondocks/myco-shared/execution-profile';
import { RUNNER_HARNESSES } from '../../packages/myco-shared/src/runner-harnesses.generated.ts';
import { HARNESSES } from '@myco/runner/harnesses.js';
import YAML from 'yaml';
import { SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';

const BEFORE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/runner-harnesses-before-manifests.json'), 'utf-8')) as Record<string, unknown>;
/** The same value through JSON, as the fixture holds it: key order and readonly arrays are not facts. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('the harness facts the manifests\' runner blocks hold', () => {
  it('are each harness\'s credential, in the order a worker ranks them', () => {
    expect(asJson(HARNESS_CREDENTIALS)).toEqual(BEFORE.HARNESS_CREDENTIALS);
    expect(Object.keys(HARNESS_CREDENTIALS)).toEqual(Object.keys(BEFORE.HARNESS_CREDENTIALS as object));
  });

  it('are the Deployment\'s secret slots, a harness\'s own among them, in the order the settings page lists them', () => {
    expect(asJson(SECRET_SLOTS)).toEqual(BEFORE.SECRET_SLOTS);
    expect(asJson(SECRET_SLOT_NAMES)).toEqual(BEFORE.SECRET_SLOT_NAMES);
    // Every slot a harness reads is one the Deployment stores.
    for (const harness of RUNNER_HARNESSES) {
      const slot = harness.credential.slot;
      expect({ harness: harness.id, stored: slot === null || (SECRET_SLOT_NAMES as readonly string[]).includes(slot) }).toEqual({ harness: harness.id, stored: true });
    }
  });

  it('are each harness\'s tier profile, and the harnesses whose models are configurable', () => {
    // The family prefix is new with the fold: it was written into `profileModelMatches` before.
    const profiles = asJson(PROFILE_HARNESSES) as Record<string, Record<string, unknown>>;
    for (const profile of Object.values(profiles)) delete profile.modelFamilyPrefix;
    expect(profiles).toEqual(BEFORE.PROFILE_HARNESSES as Record<string, Record<string, unknown>>);
    expect(asJson(CONFIGURABLE_PROFILE_HARNESSES)).toEqual(BEFORE.CONFIGURABLE_PROFILE_HARNESSES);
  });

  it('are how each harness is held to a run\'s grant, and the harnesses a worker may offer', () => {
    expect(asJson(HARNESS_ASKING)).toEqual(BEFORE.HARNESS_ASKING as Record<string, unknown>);
    expect(Object.keys(HARNESS_ASKING)).toEqual(Object.keys(BEFORE.HARNESS_ASKING as object));
    expect(asJson(OFFERABLE_PROFILE_HARNESSES)).toEqual(BEFORE.OFFERABLE_PROFILE_HARNESSES);
  });

  it('match a dated model id to the alias of its family, as the prefix the manifest declares says', () => {
    expect(profileModelMatches('claude-code', 'sonnet', 'claude-sonnet-4-5-20250929')).toBe(true);
    expect(profileModelMatches('claude-code', 'sonnet', 'claude-opus-4-1')).toBe(false);
    expect(profileModelMatches('claude-code', 'sonnet', 'sonnet-4')).toBe(false);
    expect(profileModelMatches('codex', 'gpt-5', 'gpt-5')).toBe(true);
  });

  it('are how a worker runs each harness: binary, launch, login, isolation, permissions, source git, model setting and accounting, in rank order', () => {
    expect(HARNESSES.map((h) => h.id)).toEqual((BEFORE.HARNESSES as Array<{ id: string }>).map((h) => h.id));
    for (const [i, harness] of HARNESSES.entries()) {
      expect({ harness: harness.id, facts: asJson(harness) }).toEqual({ harness: harness.id, facts: (BEFORE.HARNESSES as unknown[])[i] });
    }
  });

  it('inject each harness\'s credential under the variable it reads, and nothing for one with no slot', () => {
    expect(credentialEnvFor('claude-code', 'sk-ant-oat-1')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-1' });
    expect(credentialEnvFor('claude-code', 'sk-ant-api-1')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api-1' });
    expect(credentialEnvFor('codex', 'sk-1')).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(credentialEnvFor('antigravity', 'k')).toEqual({});
    expect(harnessesReading('anthropic')).toEqual(['claude-code', 'opencode', 'cursor']);
  });

  it('name only a slot the Deployment stores, so a misspelt slot fails the generator rather than a run', () => {
    const manifest = YAML.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../packages/myco/src/symbionts/manifests/claude-code.yaml'), 'utf-8')) as { runner: { credential: { slot: string } } };
    expect(SymbiontManifestSchema.safeParse(manifest).success).toBe(true);
    manifest.runner.credential.slot = 'antropic';
    const parsed = SymbiontManifestSchema.safeParse(manifest);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(['runner.credential.slot']);
  });
});
