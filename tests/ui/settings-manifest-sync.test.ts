// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import {
  ProjectConfigSchema,
  GroveConfigSchema,
  MachineConfigSchema,
} from '../../packages/myco/src/config/schema';
import { SETTINGS_GROUPS } from '../../packages/myco/ui/src/settings/manifest';
import { walkSchemaFields, type SchemaField } from '../../packages/myco/ui/src/settings/zod-walker';

// Keys/prefixes that legitimately have no manifest entry. Anything not
// matched here must appear in the manifest, or the test fails.
const ALLOWLIST: readonly string[] = [
  'cortex.',
  'appearance.',
  'symbionts.',
  'version',
  'config_version',
  'machine_id',
  // Team owns its own page (worker URL, credentials, sync controls). The
  // unified Settings page deliberately does not surface any team.* fields.
  'team.',
  'agent.tasks',
  'agent.summary_batch_interval',
  'agent.cold_project_threshold_days',
  'agent.provider.local_backend',
  'agent.provider.reasoning_map',
  // Per-tier reasoning-budget maps (PR #609) are yaml-only advanced config,
  // same as reasoning_map; a Settings editor is an explicit fast-follow.
  'agent.provider.thinking_budget_map',
  'agent.provider.effort_map',
  'notifications.domains',
  // release_provenance.reconcile_interval_minutes appears in BOTH the project
  // tier (ReleaseProvenanceSchema) and the grove tier (GroveReleaseProvenanceSchema).
  // Canonical owner is Grove; the project copy exists so personal/project
  // overlays can override per-project. UI exposes only the Grove entry.
  'release_provenance.reconcile_interval_minutes',
  // Capability master gates surface in the capability panel (UI plan), not the
  // settings manifest. vault_evolution is a new top-level block; skills.enabled
  // is added here alongside the existing skills.* threshold fields.
  'vault_evolution.',
  'skills.enabled',
  // Admission ignore list — managed via the Groves "Ignore" action and the
  // machine settings page, not a per-field settings card.
  'capture.ignore.',
  // Auto-update check cadence — an internal daemon setting. The Upgrade card
  // surfaces only the channel (daemon.update_channel), not the poll interval.
  'daemon.check_interval_hours',
  // Daemon port — derived from the service path by default; an override is
  // edited directly in config.yaml, not surfaced as a settings card.
  'daemon.port',
];

function isAllowlisted(key: string): boolean {
  return ALLOWLIST.some((pattern) =>
    pattern.endsWith('.')
      ? key.startsWith(pattern)
      : key === pattern || key.startsWith(`${pattern}.`),
  );
}

const ALL_MANIFEST_FIELDS = SETTINGS_GROUPS.flatMap((g) => g.fields);

const SCHEMA_FIELDS_BY_SCOPE = {
  project: walkSchemaFields(ProjectConfigSchema),
  grove: walkSchemaFields(GroveConfigSchema),
  machine: walkSchemaFields(MachineConfigSchema),
} as const;

function kindMatches(zodKind: SchemaField['kind'], manifestKind: string): boolean {
  if (zodKind === manifestKind) return true;
  // text covers both plain strings and the env-name fields we render as text.
  if (zodKind === 'text' && manifestKind === 'secret') return true;
  return false;
}

describe('settings manifest sync', () => {
  it('every manifest entry has a backing Zod field', () => {
    const errors: string[] = [];
    for (const entry of ALL_MANIFEST_FIELDS) {
      const schemaFields = SCHEMA_FIELDS_BY_SCOPE[entry.scope];
      const match = schemaFields.find((f) => f.key === entry.key);
      if (!match) {
        errors.push(
          `Manifest entry "${entry.key}" (${entry.scope}) is missing from the Zod schema.`,
        );
        continue;
      }
      if (!kindMatches(match.kind, entry.kind)) {
        errors.push(
          `Manifest entry "${entry.key}" has kind "${entry.kind}" but Zod kind is "${match.kind}".`,
        );
      }
    }
    if (errors.length > 0) throw new Error(`Sync errors:\n  ${errors.join('\n  ')}`);
  });

  it('every Zod field has a manifest entry (or matches the allowlist)', () => {
    const manifestKeysByScope: Record<string, Set<string>> = {
      project: new Set(),
      grove: new Set(),
      machine: new Set(),
    };
    for (const entry of ALL_MANIFEST_FIELDS) manifestKeysByScope[entry.scope].add(entry.key);

    const errors: string[] = [];
    for (const [scope, fields] of Object.entries(SCHEMA_FIELDS_BY_SCOPE)) {
      for (const field of fields) {
        if (manifestKeysByScope[scope].has(field.key)) continue;
        if (isAllowlisted(field.key)) continue;
        if (field.kind === 'object' || field.kind === 'record') continue;
        errors.push(
          `Zod field "${field.key}" (${scope}) has no manifest entry and is not allowlisted.`,
        );
      }
    }
    if (errors.length > 0) throw new Error(`Missing manifest entries:\n  ${errors.join('\n  ')}`);
  });
});
