export interface BudgetStatus {
  active: boolean; reason: string | null; dailyUsd: number;
  automaticUsd: number | null; manualUsd: number | null; liveUsd: number | null;
  unconfirmed: {count:number;estimatedUsd:number;manual:{count:number;estimatedUsd:number};automatic:{count:number;estimatedUsd:number}} | null;
  heldHeads: {projectId:string;runId:string;task:string;reason:'budget'|'budget_too_small';requiredUsd:number|null;quotedAt:number|null}[] | null;
  pricedExposure: {usd:number|null;sampleSize:number;missingSamples:number;provenance:'empirical-p95'} | null;
}

/** Estimates for unpriced and lost attempts do not establish an actual-spend bound. */
export function budgetStatusLine(status: BudgetStatus): string {
  if (!status.active) return `Daily work budget inactive: ${status.reason}`;
  const dollars=(value:number|null)=>value===null?'unavailable':`$${value.toFixed(2)}`;
  const unknown=status.unconfirmed;
  const exposure=status.pricedExposure;
  const held=status.heldHeads?.map(head=>head.reason==='budget_too_small'
    ? `${head.task}: raise the budget to ${dollars(head.requiredUsd)} for run ${head.runId} (last quote)` : `${head.task}: waiting for budget`).join(', ');
  return `Daily work budget: ${dollars(status.dailyUsd)}; automatic ${dollars(status.automaticUsd)}, hand-started ${dollars(status.manualUsd)}; live estimates ${dollars(status.liveUsd)}. Unconfirmed spend: ${unknown?.count ?? 'unavailable'} attempts, ${dollars(unknown?.estimatedUsd ?? null)} estimated${unknown!==null&&unknown.count>0?'; actual spend unknown':''}; automatic ${unknown?.automatic.count ?? 'unavailable'} (${dollars(unknown?.automatic.estimatedUsd ?? null)}), hand-started ${unknown?.manual.count ?? 'unavailable'} (${dollars(unknown?.manual.estimatedUsd ?? null)}). Budget-held task heads: ${status.heldHeads?.length ?? 'unavailable'}${held?` (${held})`:''}. Priced exposure: ${dollars(exposure?.usd ?? null)} (empirical p95, sample ${exposure?.sampleSize ?? 0}; ${exposure?.missingSamples ?? 0} missing samples).`;
}
