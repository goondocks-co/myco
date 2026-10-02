import { parseExecutionIdentity, type CostProvenance, type RecordedIdentity } from '@goondocks/myco-shared/worker-usage';

const provenanceOf = (value: unknown): CostProvenance | null =>
  value === 'harness_actual' || value === 'harness_estimate' || value === 'model_pricing' || value === 'mixed' || value === 'unavailable' ? value : null;

/** Identity comes from usage; cost provenance comes from the selected cost scalar, with a legacy usage fallback. */
export function runAccounting(raw: unknown, canonicalProvenance?: unknown): { identity: RecordedIdentity; costProvenance: CostProvenance | null } {
  const canonical = provenanceOf(canonicalProvenance);
  if (raw == null) return { identity: { status: 'not_recorded' }, costProvenance: canonical };
  try {
    const data = JSON.parse(String(raw)) as Record<string, unknown>;
    const costProvenance = canonical ?? provenanceOf(data?.costProvenance);
    if (data?.identity === undefined) return { identity: { status: 'not_recorded' }, costProvenance };
    return { identity: parseExecutionIdentity(data.identity), costProvenance };
  } catch {
    return { identity: { status: 'unknown', reason: 'stored_accounting_unreadable' }, costProvenance: canonical };
  }
}
