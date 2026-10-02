import { profileModelMatches } from '@goondocks/myco-shared/execution-profile';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { CostProvenance, RecordedIdentity } from '@goondocks/myco-shared/worker-usage';

interface ModelEvidence {
  requested: ExecutionProfile | null;
  identity: RecordedIdentity;
  harness: string | null;
}

/** Launch intent beside the model identities reported for this attempt. */
export function ModelSummary({ run }: { run: ModelEvidence }) {
  const identity = run.identity;
  const known = identity.status === 'reported' || identity.status === 'launched';
  const models = known ? [...new Set(identity.models.map((model) => model.model))] : [];
  const mismatch = known && run.requested !== null && !profileModelMatches(run.harness ?? '', run.requested.model, identity.primary.model);
  return (
    <div className="flex flex-col gap-s1 break-words t-meta text-muted" data-model-summary="">
      <span>Requested: {run.requested === null ? 'Not recorded' : `${run.requested.tier} · ${run.requested.model}${run.requested.effort === null ? '' : ` · ${run.requested.effort} effort`}`}</span>
      <span>{known ? `${identity.status === 'reported' ? 'Actual' : 'Launched'}: ${models.join(', ')}` : 'Model not recorded'}</span>
      {mismatch && <span className="text-warn" data-model-mismatch="">Model differs from requested</span>}
    </div>
  );
}

export function costProvenanceWords(provenance: CostProvenance | null): string {
  switch (provenance) {
    case 'harness_actual': return 'Cost reported by the agent';
    case 'harness_estimate': return 'The agent’s own estimate, not a bill';
    case 'model_pricing': return 'Estimate using recorded models and prices, not a bill';
    case 'mixed': return 'Combined reported costs and model-priced estimates, not a bill';
    default: return 'Cost provenance not recorded';
  }
}
