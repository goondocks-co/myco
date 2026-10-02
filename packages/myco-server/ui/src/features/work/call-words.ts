const CALL_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  myco_run_map: { get: 'Read the code map', write: 'Wrote the code map' },
  myco_run: { report: 'Reported', state_get: 'Read its saved progress', state_set: 'Saved its progress' },
  myco_run_spores: { list: 'Listed spores', get: 'Read a spore' },
  myco_run_sessions: { list: 'Listed sessions', material: 'Read session material', title: 'Wrote a session title and summary' },
  myco_run_prompts: { unprocessed: 'Read new prompts', mark_processed: 'Marked a prompt as read' },
  myco_spores: { save: 'Saved a spore', supersede: 'Replaced a spore', obsolete: 'Retired a spore', consolidate: 'Combined spores' },
  myco_search: { '*': 'Searched Myco' },
};
const labels = new Map(Object.entries(CALL_WORDS).flatMap(([tool, ops]) => Object.entries(ops).map(([op, words]) => [`${tool}/${op}`, words] as const)));

/** A call's operation in reader words; unfamiliar operations make no claim about their effect. */
export function callWords(tool: string, op: string | null): string {
  return labels.get(`${tool}/${op ?? '*'}`) ?? 'Called Myco';
}
