import type { MycoConfig } from '@myco/config/schema.js';

export interface PackageTagMapping {
  path_glob: string;
  tag_pattern: string;
}

export interface ReleaseGithubConfig {
  /** Empty when GitHub PR evidence is disabled. */
  repo: string;
  /** Env-var name; the daemon reads the actual token from process.env. */
  token_env: string;
  max_lookups_per_run: number;
}

export interface ReleaseProvenanceRuntimeConfig {
  enabled: boolean;
  production_refs: string[];
  integration_refs: string[];
  reconcile_interval_minutes: number;
  github: ReleaseGithubConfig;
  package_map: PackageTagMapping[];
}

export function releaseProvenanceConfig(config: MycoConfig): ReleaseProvenanceRuntimeConfig {
  const release = config.release_provenance;
  return {
    enabled: release?.enabled ?? true,
    production_refs: release?.production_refs ?? [],
    integration_refs: release?.integration_refs ?? [],
    reconcile_interval_minutes: release?.reconcile_interval_minutes ?? 15,
    github: {
      repo: release?.github?.repo ?? '',
      token_env: release?.github?.token_env ?? 'GITHUB_TOKEN',
      max_lookups_per_run: release?.github?.max_lookups_per_run ?? 20,
    },
    package_map: release?.package_map ?? [],
  };
}

export function primaryProductionRef(config: MycoConfig): string | null {
  return config.release_provenance?.production_refs?.[0] ?? null;
}
