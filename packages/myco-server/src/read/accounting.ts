import { parseExecutionIdentity, type CostProvenance, type RecordedIdentity } from '@goondocks/myco-shared/worker-usage';

/** Only the accounting contract is projected; launch configuration and credentials never leave the store. */
export function runAccounting(raw: unknown): { identity: RecordedIdentity; costProvenance: CostProvenance | null } {
  if (raw == null) return { identity: { status: 'not_recorded' }, costProvenance: null };
  try {
    const data = JSON.parse(String(raw)) as Record<string, unknown>;
    if (data?.identity === undefined) return { identity: { status: 'not_recorded' }, costProvenance: null };
    const identity = parseExecutionIdentity(data.identity);
    const provenance = data.costProvenance;
    return { identity, costProvenance: provenance === 'harness_actual' || provenance === 'harness_estimate' || provenance === 'model_pricing' || provenance === 'unavailable' ? provenance : null };
  } catch {
    return { identity: { status: 'unknown', reason: 'stored_accounting_unreadable' }, costProvenance: null };
  }
}
