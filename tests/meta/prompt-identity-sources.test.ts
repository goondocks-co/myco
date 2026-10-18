/**
 * Prompt ids have one derivation and one declaration per agent.
 *
 * - No source derives a prompt id outside the registry (`@goondocks/myco-shared/prompt-identity`): a `uuidv5` or
 *   `deriveId` naming a prompt namespace anywhere else is a second minter.
 * - Every shipped manifest declares its agent's prompt identity, and the generated hook config and capture rules carry
 *   it as the schema resolves it, with the `hook-owned` kind derived from the turn-row source.
 * - A `transcript-only` agent that wires a prompt hook names hook-input evidence that its hook carries no key a
 *   `harness-key` agent shares, so a regression that demotes an agent fails here.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { OFFSET_PROMPT_NAMESPACES, PROMPT_ID_SCHEMES } from '@goondocks/myco-shared/prompt-identity';
import { resolvePromptIdentity, SymbiontManifestSchema } from '@myco/symbionts/manifest-schema.js';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const PACKAGES = path.join(ROOT, 'packages');
const REGISTRY = path.join(PACKAGES, 'myco-shared', 'src', 'prompt-identity.ts');
const MANIFESTS = path.join(PACKAGES, 'myco', 'src', 'symbionts', 'manifests');
const TEMPLATES = path.join(PACKAGES, 'myco', 'src', 'symbionts', 'templates');
/** Every namespace a prompt id is derived under. */
const PROMPT_NAMESPACES = ['queued-prompt', 'transcript-prompt', 'prompt', ...OFFSET_PROMPT_NAMESPACES];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'ui' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });
}

describe('prompt id sources', () => {
  it('derives a prompt id nowhere but the registry', () => {
    const call = new RegExp(`\\b(?:uuidv5|deriveId|offsetIdFor)\\(\\s*'(${PROMPT_NAMESPACES.join('|')})'|\\b(?:legacyId\\(|deriveId\\(\\s*'legacy')[^)]*'prompt'\\s*,`, 'g');
    const found = sources(PACKAGES).filter((file) => file !== REGISTRY).flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(call)].map((m) => `${path.relative(ROOT, file)}: ${m[0]}`));
    expect(found).toEqual([]);
  });

  it('declares every derived and minted scheme a manifest may name in the registry', () => {
    for (const bundle of CAPTURE_RULE_BUNDLES) expect({ agent: bundle.name, known: bundle.promptIdentity.scheme in PROMPT_ID_SCHEMES }).toEqual({ agent: bundle.name, known: true });
  });
});

describe('prompt identity declarations', () => {
  const manifests = fs.readdirSync(MANIFESTS).filter((f) => f.endsWith('.yaml')).map((f) => YAML.parse(fs.readFileSync(path.join(MANIFESTS, f), 'utf8')) as Record<string, any>);

  it('is declared by every shipped manifest, and carried to both sides as the schema resolves it', () => {
    for (const raw of manifests) {
      expect({ agent: raw.name, declared: raw.promptIdentity !== undefined }).toEqual({ agent: raw.name, declared: true });
      const parsed = SymbiontManifestSchema.parse(raw);
      const resolved = resolvePromptIdentity(parsed.promptIdentity, parsed.capabilities?.turnRowSource ?? 'hook');
      expect(resolved.ok).toBe(true);
      const declaration = resolved.ok ? resolved.declaration : null;
      expect(HOOK_CONFIG[raw.name]?.promptIdentity).toEqual(declaration!);
      expect(CAPTURE_RULE_BUNDLES.find((b) => b.name === raw.name)?.promptIdentity).toEqual(declaration!);
    }
  });

  it('derives hook-owned from the turn-row source, and refuses a kind that contradicts it', () => {
    expect(resolvePromptIdentity({ scheme: 'hook-mint-v1' }, 'hook')).toEqual({ ok: true, declaration: { kind: 'hook-owned', scheme: 'hook-mint-v1' } });
    expect(resolvePromptIdentity(undefined, 'transcript').ok).toBe(false);
    expect(resolvePromptIdentity({ scheme: 'hook-mint-v1' }, 'transcript').ok).toBe(false);
    expect(resolvePromptIdentity({ kind: 'harness-key', scheme: 'claude-v1', hookKey: 'prompt_id', transcriptKey: 'promptId' }, 'hook').ok).toBe(false);
    expect(resolvePromptIdentity({ kind: 'stamped', scheme: 'claude-v1' }, 'transcript').ok).toBe(false);
    expect(resolvePromptIdentity({ kind: 'harness-key', scheme: 'claude-v1' }, 'transcript').ok).toBe(false);
    expect(resolvePromptIdentity({ kind: 'stamped', scheme: 'stamp-or-offset-v1', evidence: 'x.json' }, 'transcript').ok).toBe(false);
  });

  it('names hook-input evidence for a transcript-only agent with a prompt hook, carrying no key a harness-key agent shares', () => {
    const sharedKeys = new Set(Object.values(HOOK_CONFIG).flatMap((entry) => entry.promptIdentity.hookKey === undefined ? [] : [entry.promptIdentity.hookKey]));
    expect(sharedKeys.size).toBeGreaterThan(0);
    for (const raw of manifests) {
      const entry = HOOK_CONFIG[raw.name]!;
      if (entry.promptIdentity.kind !== 'transcript-only') continue;
      const template = fs.readdirSync(path.join(TEMPLATES, raw.name)).map((f) => fs.readFileSync(path.join(TEMPLATES, raw.name, f), 'utf8')).join('\n');
      const promptHook = Object.values(entry.hookEvents).some((e) => e.hook === 'user-prompt-submit') || template.includes('"user-prompt-submit"');
      const evidence = raw.promptIdentity.evidence as string | undefined;
      expect({ agent: raw.name, evidence: evidence !== undefined }).toEqual({ agent: raw.name, evidence: promptHook });
      if (evidence === undefined) continue;
      const stdin = JSON.parse(fs.readFileSync(path.join(ROOT, evidence), 'utf8')) as Record<string, unknown>;
      expect({ agent: raw.name, prompt: typeof stdin[entry.hookFields.prompt as string] }).toEqual({ agent: raw.name, prompt: 'string' });
      expect({ agent: raw.name, keys: Object.keys(stdin).filter((k) => sharedKeys.has(k)) }).toEqual({ agent: raw.name, keys: [] });
    }
  });
});
