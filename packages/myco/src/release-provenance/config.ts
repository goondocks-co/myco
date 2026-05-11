import type { MycoConfig } from '@myco/config/schema.js';

export interface ReleaseProvenanceRuntimeConfig {
  enabled: boolean;
  production_refs: string[];
  integration_refs: string[];
  reconcile_interval_minutes: number;
}

export function releaseProvenanceConfig(config: MycoConfig): ReleaseProvenanceRuntimeConfig {
  return {
    enabled: config.release_provenance?.enabled ?? true,
    production_refs: config.release_provenance?.production_refs ?? [],
    integration_refs: config.release_provenance?.integration_refs ?? [],
    reconcile_interval_minutes: config.release_provenance?.reconcile_interval_minutes ?? 15,
  };
}

export function primaryProductionRef(config: MycoConfig): string | null {
  return config.release_provenance?.production_refs?.[0] ?? null;
}
