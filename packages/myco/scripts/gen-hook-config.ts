/**
 * Codegen: packages/myco/src/hooks/hook-config.generated.ts
 *
 * Every Myco hook runs in a short-lived Node process; cursor in particular
 * fires hooks on nearly every keystroke. Parsing the symbiont YAML manifests
 * + running Zod validation at hook startup was the single largest per-hook
 * cost on feat/steering-prompt-capture. The manifests are static at runtime
 * — they ship inside the dist bundle and never change outside of development
 * — so bake the hook-relevant subset into TypeScript at build time.
 *
 * Only the fields hooks actually read make it into the generated const:
 *   - identity the hook uses to detect its symbiont (pluginRootEnvVar,
 *     configDir) and the hookFields mapping that normalizes its stdin
 *   - hookEvents — per harness event, the Myco hook the template wires and
 *     the timeout the template declares for it (symbionts/templates/<sym>/hooks.json)
 *   - capture.planDirs / capture.planTags / capture.transcriptDiscovery
 *   - the capability flags hook responses are gated on
 *   - registration.hookResponse (format + fieldNames)
 *   - capture.prompts (shapes, resetBoundaries, interruptMarker)
 *   - capture.rules
 *
 * Skills, MCP targets, hook-target paths, installer fields, etc. live
 * outside the hook hot path and stay loaded through loadManifests() for
 * the installer / daemon / UI.
 *
 * The generator is importable: `renderHookConfigSources()` returns both
 * outputs as strings so `tests/meta/hook-config-generated-fresh.test.ts`
 * can regenerate in memory and compare against the committed files.
 * Writing happens only when this file is the process entry.
 *
 * Run manually via: npx tsx packages/myco/scripts/gen-hook-config.ts
 * Wired into npm: `npm run codegen` runs automatically before `npm run build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SymbiontManifestSchema, type SymbiontManifest } from '../src/symbionts/manifest-schema.js';
import { hookNameInCommand } from '../src/member/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const MANIFESTS_DIR = path.resolve(PACKAGE_ROOT, 'src/symbionts/manifests');
const TEMPLATES_DIR = path.resolve(PACKAGE_ROOT, 'src/symbionts/templates');
const OUTPUT_PATH = path.resolve(PACKAGE_ROOT, 'src/hooks/hook-config.generated.ts');
const FULL_MANIFESTS_OUTPUT_PATH = path.resolve(PACKAGE_ROOT, 'src/symbionts/manifests.generated.ts');

/** One harness event: the Myco hook its template wires and the declared timeout (seconds). */
export interface HookEventEntry {
  hook: string;
  timeout?: number;
}

interface HookConfigEntry {
  pluginRootEnvVar: string;
  configDir: string;
  hookFields: SymbiontManifest['hookFields'];
  hookEvents: Record<string, HookEventEntry>;
  planDirs: string[];
  planTags: string[];
  capabilities: {
    preToolUseInjection: boolean;
    sessionStartInjection: boolean;
    subagentStartInjection: boolean;
  };
  transcriptDiscovery?: unknown;
  hookResponse?: unknown;
  capturePrompts?: unknown;
  captureRules?: unknown;
  subagentParentPath?: string;
  subagentThreadIdPath?: string;
  subagentLabelPath?: string;
  sessionContinuation?: unknown;
}

/**
 * Walk a symbiont's hooks.json template and collect, per harness event name,
 * the Myco hook it runs and the timeout it declares. Templates differ in
 * nesting (Claude Code wraps commands in matcher groups under a `hooks`
 * array; Antigravity nests its events under a `myco` key; Cursor and Windsurf
 * list commands directly), so the walk keys an entry by the nearest enclosing
 * object key that is not the `hooks` wrapper. Two entries for one event must
 * agree on hook and timeout, and every event that wires one hook name must
 * declare the same timeout (a hook process knows its hook name, not the
 * harness event, so a budget read by hook name has exactly one answer); a
 * template that disagrees with itself is a generator error, not a silent pick.
 */
export function collectHookEvents(template: unknown, templatePath: string): Record<string, HookEventEntry> {
  const collected: Record<string, HookEventEntry> = {};
  const timeoutByHook = new Map<string, number | undefined>();
  const visit = (node: unknown, event: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, event);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.command === 'string') {
      const hook = hookNameInCommand(record.command);
      if (!hook) throw new Error(`${templatePath}: command does not name a myco hook: ${record.command}`);
      if (!event) throw new Error(`${templatePath}: hook command outside any event key: ${record.command}`);
      const entry: HookEventEntry = { hook };
      if (typeof record.timeout === 'number') entry.timeout = record.timeout;
      const existing = collected[event];
      if (existing && (existing.hook !== entry.hook || existing.timeout !== entry.timeout)) {
        throw new Error(`${templatePath}: event ${event} wires conflicting hook entries`);
      }
      if (timeoutByHook.has(entry.hook) && timeoutByHook.get(entry.hook) !== entry.timeout) {
        throw new Error(`${templatePath}: hook ${entry.hook} is wired with different timeouts across events`);
      }
      timeoutByHook.set(entry.hook, entry.timeout);
      collected[event] = entry;
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      visit(value, key === 'hooks' ? event : key);
    }
  };
  visit(template, undefined);
  const sorted: Record<string, HookEventEntry> = {};
  for (const event of Object.keys(collected).sort()) sorted[event] = collected[event];
  return sorted;
}

function loadHookEvents(symbiontName: string): Record<string, HookEventEntry> {
  const templatePath = path.join(TEMPLATES_DIR, symbiontName, 'hooks.json');
  if (!fs.existsSync(templatePath)) return {};
  const template: unknown = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  return collectHookEvents(template, path.relative(PACKAGE_ROOT, templatePath));
}

function loadManifestsSorted(): SymbiontManifest[] {
  if (!fs.existsSync(MANIFESTS_DIR)) {
    throw new Error(`manifests directory missing: ${MANIFESTS_DIR}`);
  }
  const files = fs.readdirSync(MANIFESTS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  if (files.length === 0) {
    throw new Error(`no YAML manifests found in ${MANIFESTS_DIR}`);
  }
  return files.map((file) => {
    const raw = YAML.parse(fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf-8'));
    return SymbiontManifestSchema.parse(raw);
  });
}

function hookConfigEntryFor(manifest: SymbiontManifest): HookConfigEntry {
  const entry: HookConfigEntry = {
    pluginRootEnvVar: manifest.pluginRootEnvVar,
    configDir: manifest.configDir,
    hookFields: manifest.hookFields,
    hookEvents: loadHookEvents(manifest.name),
    planDirs: manifest.capture?.planDirs ?? [],
    planTags: manifest.capture?.planTags ?? [],
    capabilities: {
      preToolUseInjection: manifest.capabilities?.preToolUseInjection === true,
      sessionStartInjection: manifest.capabilities?.sessionStartInjection === true,
      subagentStartInjection: manifest.capabilities?.subagentStartInjection === true,
    },
  };
  if (manifest.capture?.transcriptDiscovery) {
    entry.transcriptDiscovery = manifest.capture.transcriptDiscovery;
  }
  const hookResponse = manifest.registration?.hookResponse;
  if (hookResponse) entry.hookResponse = hookResponse;
  const capturePrompts = manifest.capture?.prompts;
  if (capturePrompts) entry.capturePrompts = capturePrompts;
  const captureRules = manifest.capture?.rules;
  if (captureRules && captureRules.length > 0) entry.captureRules = captureRules;
  if (manifest.capture?.subagentParentPath) entry.subagentParentPath = manifest.capture.subagentParentPath;
  if (manifest.capture?.subagentThreadIdPath) entry.subagentThreadIdPath = manifest.capture.subagentThreadIdPath;
  if (manifest.capture?.subagentLabelPath) entry.subagentLabelPath = manifest.capture.subagentLabelPath;
  if (manifest.capture?.sessionContinuation) entry.sessionContinuation = manifest.capture.sessionContinuation;
  return entry;
}

export interface HookConfigSources {
  /** Contents of src/hooks/hook-config.generated.ts. */
  hookConfig: string;
  /** Contents of src/symbionts/manifests.generated.ts. */
  bundledManifests: string;
  symbiontCount: number;
}

/** Render both generated sources from the manifests and hook templates on disk. */
export function renderHookConfigSources(): HookConfigSources {
  const manifests = loadManifestsSorted();

  const entries: Record<string, HookConfigEntry> = {};
  for (const manifest of manifests) {
    entries[manifest.name] = hookConfigEntryFor(manifest);
  }

  const body = JSON.stringify(entries, null, 2);
  const hookConfig = `// AUTO-GENERATED by scripts/gen-hook-config.ts — DO NOT EDIT.
// Run \`npm run codegen\` (or \`npx tsx packages/myco/scripts/gen-hook-config.ts\`) to regenerate.
//
// This file bakes the hook-relevant subset of every symbiont manifest into
// a typed const so hooks don't pay for YAML I/O + Zod parsing on every
// short-lived hook process. Keep it checked into git so tests don't need
// a build step. tests/meta/hook-config-generated-fresh.test.ts fails when
// this file drifts from the manifests or hook templates.

import type {
  CapturePrompts,
  CaptureRule,
  SessionContinuation,
  SymbiontManifest,
  SymbiontRegistration,
  TranscriptDiscovery,
} from '../symbionts/manifest-schema.js';

/** One harness event: the Myco hook its template wires and the declared timeout (seconds). */
export interface HookEventEntry {
  hook: string;
  timeout?: number;
}

/** The capability flags hook responses are gated on. */
export interface HookCapabilities {
  preToolUseInjection: boolean;
  sessionStartInjection: boolean;
  subagentStartInjection: boolean;
}

export interface HookConfigEntry {
  pluginRootEnvVar: string;
  configDir: string;
  hookFields: SymbiontManifest['hookFields'];
  /** Keyed by the harness's own event name (e.g. \`Stop\`, \`post_cascade_response\`). */
  hookEvents: Record<string, HookEventEntry>;
  planDirs: string[];
  planTags: string[];
  capabilities: HookCapabilities;
  transcriptDiscovery?: TranscriptDiscovery;
  hookResponse?: NonNullable<SymbiontRegistration['hookResponse']>;
  capturePrompts?: CapturePrompts;
  captureRules?: CaptureRule[];
  subagentParentPath?: string;
  subagentThreadIdPath?: string;
  subagentLabelPath?: string;
  sessionContinuation?: SessionContinuation;
}

export const HOOK_CONFIG: Readonly<Record<string, HookConfigEntry>> = ${body} as const;
`;

  // Also emit the full parsed manifests so `loadManifests()` can fall back to
  // the bundled data when the filesystem layout is absent (compiled Bun binary:
  // manifest YAML files are inside the /$bunfs/ virtual FS and fs.readdirSync
  // can't enumerate them).
  const bundledManifests = `// AUTO-GENERATED by scripts/gen-hook-config.ts — DO NOT EDIT.
// Run \`npm run codegen\` to regenerate.
//
// Full parsed symbiont manifests bundled for the compiled binary path.
// loadManifests() in symbionts/detect.ts prefers the filesystem candidates
// (source/dist layouts) when they're populated and falls back to this array
// for the compiled-Bun case where manifest YAMLs aren't enumerable on disk.

import type { SymbiontManifest } from './manifest-schema.js';

export const BUNDLED_MANIFESTS: readonly SymbiontManifest[] = ${JSON.stringify(manifests, null, 2)} as const;
`;

  return { hookConfig, bundledManifests, symbiontCount: manifests.length };
}

function main(): void {
  const { hookConfig, bundledManifests, symbiontCount } = renderHookConfigSources();
  fs.writeFileSync(OUTPUT_PATH, hookConfig);
  process.stdout.write(`[gen-hook-config] wrote ${path.relative(PACKAGE_ROOT, OUTPUT_PATH)} (${symbiontCount} symbionts)\n`);
  fs.writeFileSync(FULL_MANIFESTS_OUTPUT_PATH, bundledManifests);
  process.stdout.write(`[gen-hook-config] wrote ${path.relative(PACKAGE_ROOT, FULL_MANIFESTS_OUTPUT_PATH)} (${symbiontCount} manifests)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
