import { EFFORT_UNAPPLIED, profileModelMatches } from '@goondocks/myco-shared/execution-profile';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { CostProvenance, RecordedIdentity } from '@goondocks/myco-shared/worker-usage';

interface ModelEvidence {
  requested: ExecutionProfile | null;
  identity: RecordedIdentity;
  harness: string | null;
}

/** Launch intent beside the model identities reported for this attempt. */
export function ModelSummary({ run, variant = 'summary' }: { run: ModelEvidence; variant?: 'summary' | 'list' | 'details' }) {
  const identity = run.identity;
  const known = identity.status === 'reported' || identity.status === 'launched';
  const models = known ? [...new Set(identity.models.map((model) => model.model))] : [];
  const mismatch = known && run.requested !== null && run.harness !== null && !profileModelMatches(run.harness, run.requested.model, identity.primary);
  if (variant !== 'details' && run.requested === null && !known) return null;
  const different = mismatch && <span className="text-warn" data-model-mismatch="">Ran a different model than requested</span>;
  const effortSkipped = known && identity.warnings?.includes(EFFORT_UNAPPLIED) === true
    && <span className="text-warn" data-effort-unapplied="">Effort not applied: the agent offered no effort setting for this model</span>;
  if (variant === 'list') {
    const model = run.requested?.model;
    const asked = model === undefined ? null : `Asked for ${displayModel(model)}${run.requested?.effort == null ? '' : `, ${run.requested.effort} effort`}`;
    const actual = known ? `${identity.status === 'reported' ? 'ran' : 'launched'} ${models.join(', ')}` : null;
    return <div className="flex flex-col gap-s1 break-words t-meta text-muted" data-model-summary=""><span>{[asked, actual].filter(Boolean).join(' · ')}</span>{different}{effortSkipped}</div>;
  }
  return (
    <div className="flex flex-col gap-s1 break-words t-meta text-muted" data-model-summary="">
      {(run.requested !== null || variant === 'details') && <span>Requested: {run.requested === null ? 'Not recorded' : `${run.requested.tier} · ${run.requested.model}${run.requested.effort === null ? '' : ` · ${run.requested.effort} effort`}`}</span>}
      {(known || variant === 'details') && <span>{known ? `${identity.status === 'reported' ? 'Actual' : 'Launched'}: ${models.join(', ')}` : 'Model not recorded'}</span>}
      {different}
      {effortSkipped}
    </div>
  );
}

/** Reader-facing names for the Claude model choices in settings. */
export function displayModel(model: string): string {
  return ['opus', 'sonnet', 'haiku'].includes(model) ? model.charAt(0).toUpperCase() + model.slice(1) : model;
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
