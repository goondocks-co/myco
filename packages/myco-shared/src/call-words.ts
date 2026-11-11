const CALL_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  myco_run_map: { get: 'Read the code map', write: 'Wrote the code map' },
  myco_run: { report: 'Reported', state_get: 'Read its saved progress', state_set: 'Saved its progress' },
  myco_run_spores: { list: 'Listed spores', get: 'Read a spore' },
  myco_run_sessions: { list: 'Listed sessions', material: 'Read session material', title: 'Wrote a session title and summary' },
  myco_run_cards: { material: 'Read turns to card', write: 'Wrote turn cards' },
  myco_run_learning: { material: 'Read session cards', get: 'Read a raw turn', complete: 'Completed a learning slice' },
  myco_spores: { save: 'Saved a spore', supersede: 'Replaced a spore', obsolete: 'Retired a spore', consolidate: 'Combined spores' },
  myco_search: { '*': 'Searched Myco' },
  '/runs/claim': { '*': 'Claimed the run' },
  '/runs/update': { '*': 'Sent its status' },
  '/runs/report': { '*': 'Reported' },
  '/runs/embedding-step': { '*': 'Advanced the search index' },
};
const labels = new Map(Object.entries(CALL_WORDS).flatMap(([tool, ops]) => Object.entries(ops).map(([op, words]) => [`${tool}/${op}`, words] as const)));

/** What a route call's recorded step did, in reader words, by route and step; a step not named here is not described. */
const STEP_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/runs/embedding-step': {
    missing: 'made a new source searchable',
    stale: 'refreshed a changed source',
    switch: 'prepared a source for the new search model',
    'passed-over': 'set aside a source it could not index',
    orphans: 'removed an entry whose source is gone',
    hubness: 'checked how evenly search ranks results',
    'vector-page': 'checked part of the index',
    visibility: 'checked what search can find',
    settled: 'found the index up to date',
    scan: 'looked for work to do',
  },
};

/** A route call's recorded step in reader words, or null where its step is unrecorded or not described. */
export function callStepWords(tool: string, op: string | null): string | null {
  return op === null ? null : STEP_WORDS[tool]?.[op] ?? null;
}

/** A call's operation in reader words; unfamiliar operations make no claim about their effect. */
export function callWords(tool: string, op: string | null): string {
  return labels.get(`${tool}/${op ?? '*'}`) ?? labels.get(`${tool}/*`) ?? 'Called Myco';
}
