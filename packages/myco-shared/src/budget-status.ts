/** The daily work budget in US dollars while none is stored. */
export const BUDGET_DEFAULT_USD = 20;

export interface BudgetStatus {
  active: boolean; reason: string | null; dailyUsd: number;
  automaticUsd: number | null; manualUsd: number | null; liveUsd: number | null;
  unconfirmed: {count:number;estimatedUsd:number;manual:{count:number;estimatedUsd:number};automatic:{count:number;estimatedUsd:number}} | null;
  heldHeads: {projectId:string;runId:string;task:string;reason:'budget'|'budget_too_small';requiredUsd:number|null;quotedAt:number|null}[] | null;
  pricedExposure: {usd:number|null;sampleSize:number;missingSamples:number;provenance:'empirical-p95'} | null;
  /** `building` while rolling spend accounting catches up with attempt history: totals are unknown, not zero, and automatic work waits. */
  state?: 'ready' | 'building';
}

/** Estimates for unpriced and lost attempts do not establish an actual-spend bound. */
export function budgetStatusLine(status: BudgetStatus): string {
  if (!status.active) return `Daily work budget inactive: ${status.reason}`;
  if (status.state === 'building') return 'Daily work budget: measuring recent spend; automatic work waits until it is measured.';
  const dollars=(value:number|null)=>value===null?'unavailable':`$${value.toFixed(2)}`;
  const unknown=status.unconfirmed;
  const exposure=status.pricedExposure;
  const held=status.heldHeads?.map(head=>head.reason==='budget_too_small'
    ? `${head.task}: raise the budget to ${dollars(head.requiredUsd)} for run ${head.runId} (last quote)` : `${head.task}: waiting for budget`).join(', ');
  return `Daily work budget: ${dollars(status.dailyUsd)}; automatic ${dollars(status.automaticUsd)}, hand-started ${dollars(status.manualUsd)}; live estimates ${dollars(status.liveUsd)}. Unconfirmed spend: ${unknown?.count ?? 'unavailable'} attempts, ${dollars(unknown?.estimatedUsd ?? null)} estimated${unknown!==null&&unknown.count>0?'; actual spend unknown':''}; automatic ${unknown?.automatic.count ?? 'unavailable'} (${dollars(unknown?.automatic.estimatedUsd ?? null)}), hand-started ${unknown?.manual.count ?? 'unavailable'} (${dollars(unknown?.manual.estimatedUsd ?? null)}). Budget-held task heads: ${status.heldHeads?.length ?? 'unavailable'}${held?` (${held})`:''}. Priced exposure: ${dollars(exposure?.usd ?? null)} (empirical p95, sample ${exposure?.sampleSize ?? 0}; ${exposure?.missingSamples ?? 0} missing samples).`;
}

/** The dashboard's sentence: spend against the budget, then only what a person can act on. */
export function budgetSummaryLine(status: BudgetStatus, words: (task: string) => string = task => task): string {
  if (!status.active) return `The daily work budget is off: ${status.reason}`;
  if (status.state === 'building' || status.automaticUsd === null) return 'Measuring recent spend; automatic work waits until it is measured.';
  const usd=(value:number)=>`$${value.toFixed(2)}`;
  const tooSmall=status.heldHeads?.filter(head=>head.reason==='budget_too_small'&&head.requiredUsd!==null)??[];
  const waiting=(status.heldHeads?.length??0)-tooSmall.length;
  const unpriced=status.unconfirmed?.count??0;
  return [`Spent ${usd(status.automaticUsd+(status.manualUsd??0))} of the ${usd(status.dailyUsd)} work budget in the last 24 hours.`,
    ...(unpriced>0?[`${unpriced} ${unpriced===1?'run':'runs'} reported no cost, counted as about ${usd(status.unconfirmed!.estimatedUsd)}.`]:[]),
    ...(waiting>0?[`${waiting} ${waiting===1?'task is':'tasks are'} waiting for room in the budget.`]:[]),
    ...tooSmall.map(head=>`${words(head.task).replace(/^./,first=>first.toUpperCase())} needs a budget of at least ${usd(head.requiredUsd!)} to run.`)].join(' ');
}
