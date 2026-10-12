const MYCO = 'packages/myco/src/';

/** The 1.4 directories under `packages/myco/src`: everything beneath each is 1.4 code. */
export const LEGACY_DIRS: readonly string[] = [
  'agent', 'backup', 'canopy', 'capture', 'cli/providers', 'config', 'context', 'daemon', 'db', 'grove', 'host',
  'intelligence', 'logs', 'notifications', 'prompts', 'providers', 'release-provenance', 'service', 'services', 'sessions',
  'spores', 'team', 'team-host', 'templates', 'test-utils', 'tools', 'vault',
];

/** The 1.4 files in directories 2.0 shares. */
export const LEGACY_FILES: readonly string[] = [
  // The 1.4 verbs the CLI dispatches to.
  'cli/agent-run.ts', 'cli/agent-tasks.ts', 'cli/attach.ts', 'cli/bootstrap.ts', 'cli/config.ts', 'cli/detect-providers.ts',
  'cli/doctor.ts', 'cli/doctor-fixes.ts', 'cli/grove.ts', 'cli/host.ts', 'cli/join.ts', 'cli/logs.ts',
  'cli/remove.ts', 'cli/restart.ts', 'cli/restore-backup.ts', 'cli/search.ts', 'cli/service.ts', 'cli/session.ts',
  'cli/setup-digest.ts', 'cli/setup-llm.ts', 'cli/shared.ts', 'cli/stats.ts', 'cli/subsystem.ts', 'cli/update.ts',
  'cli/upgrade.ts', 'cli/verify.ts',
  // What only the 1.4 verbs and the daemon read.
  'cli/args.ts', 'cli/confirm.ts', 'cli/dashboard-url.ts',
  'constants/power-jobs.ts', 'constants/skill-candidate-status.ts', 'constants/spore-status.ts',
  'mcp/server.ts', 'mcp/http.ts', 'mcp/external-surface.ts',
  'plans/identity.ts', 'plans/list-for-mcp.ts', 'plans/save-mcp.ts',
  'search-results.ts', 'semantic-search-filters.ts',
  'skills/content.ts', 'skills/publication.ts',
  'symbionts/canopy-read-tools.ts', 'symbionts/capabilities.ts', 'symbionts/index.ts', 'symbionts/injection-support.ts',
  'symbionts/parsers/index.ts', 'symbionts/parsers/types.ts', 'symbionts/legacy-skill-links.ts',
  'static-assets.generated.ts',
  'upgrade/adopt.ts', 'upgrade/auto-check.ts', 'upgrade/checker.ts', 'upgrade/in-progress.ts', 'upgrade/orchestrator.ts',
  'upgrade/schema-gap.ts', 'upgrade/spawn.ts', 'upgrade/update-events.ts',
  'utils/error-message.ts', 'utils/instrumented-fetch.ts', 'utils/interpolate-args.ts', 'utils/interpolate.ts',
  'utils/is-plain-table.ts', 'utils/json-sentinel.ts', 'utils/json.ts', 'utils/mtime-cache.ts', 'utils/parse-csv-list.ts',
  'utils/parse-json-array.ts', 'utils/per-user-lock-namespace.ts', 'utils/physical-path-identity.ts', 'utils/presence.ts',
  'utils/user-lock-root.ts', 'utils/windows-native-profile.ts',
];

export const isLegacy = (key: string): boolean =>
  LEGACY_DIRS.some((dir) => key.startsWith(`${MYCO}${dir}/`))
  || LEGACY_FILES.some((file) => key === `${MYCO}${file}`);
