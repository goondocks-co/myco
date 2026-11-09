/**
 * The search a refused text filter on a list is replaced by: one translation of the list's own narrowing, used by every
 * list and tool that refuses free text, so the call it names selects the same records the list would have read with
 * that text. A narrowing search cannot apply is named, never dropped without a word.
 */
export interface ListNarrowing {
  type: 'spore' | 'plan' | 'session';
  text: string;
  /**
   * The Projects the list reads: the named ones, `all` for every Project the caller may see, or none for the caller's
   * current Project, which a search naming no Project also reads.
   */
  projects?: readonly string[] | 'all';
  status?: string;
  observationType?: string;
  sessionId?: string;
  /** The agent and branch of the session a record belongs to. */
  agent?: string;
  branch?: string;
  /** The list's window over when records were written, in ms: from inclusive, to exclusive. */
  from?: number;
  to?: number;
  /** The list's own names for narrowing search cannot apply. */
  unsupported?: readonly string[];
}

/** The `myco_search` arguments that select what the list would, the Project reach included where it is one Project. */
export function searchRepairCall(n: ListNarrowing): { tool: 'myco_search' } & Record<string, unknown> {
  const one = Array.isArray(n.projects) && n.projects.length === 1 ? n.projects[0] : undefined;
  return {
    tool: 'myco_search', query: n.text, type: n.type, mode: 'fts',
    ...(one === undefined ? {} : { project: one }),
    ...(n.status === undefined ? {} : { status: n.status }),
    ...(n.observationType === undefined ? {} : { observation_type: n.observationType }),
    ...(n.sessionId === undefined ? {} : { session_id: n.sessionId }),
    ...(n.agent === undefined ? {} : { agent: n.agent }),
    ...(n.branch === undefined ? {} : { branch: n.branch }),
    // Search bounds are seconds, the upper one inclusive: the list's exclusive end is its last millisecond.
    ...(n.from === undefined ? {} : { since: n.from / 1000 }),
    ...(n.to === undefined ? {} : { until: (n.to - 1) / 1000 }),
  };
}

/** The same search over HTTP: one Project's search route, or the search across the Projects the list reads. */
function searchRepairPath(n: ListNarrowing): string {
  const { tool: _tool, query, project, ...args } = searchRepairCall(n);
  const params = new URLSearchParams({ q: String(query) });
  for (const [key, value] of Object.entries(args)) params.set(key, String(value));
  if (project !== undefined) return `/api/projects/${encodeURIComponent(String(project))}/search?${params}`;
  if (n.projects === undefined) return `/api/search?${params}`;
  if (Array.isArray(n.projects)) for (const id of n.projects) params.append('project', id);
  return `/api/search?${params}`;
}

/** Why a text filter on a list is refused, naming any narrowing the replacing search cannot apply. */
export function searchRepairCause(field: string, n: ListNarrowing): string {
  const reach = n.projects === 'all' ? ['every Project (myco_search reads one Project, the current one when it names none; the HTTP search reads them all)']
    : Array.isArray(n.projects) && n.projects.length > 1 ? ['more than one Project (myco_search reads one; the HTTP search reads them all)'] : [];
  const unsupported = [...(n.unsupported ?? []), ...reach];
  const broader = unsupported.length === 0 ? ''
    : ` Search cannot narrow by ${unsupported.join(' or ')}: the search named reads past that narrowing, so drop it knowingly, or list without ${field}`;
  return `${field} is not a list filter: a text match is ranked search, paged by cursor with no total, and nothing was read.${broader}`;
}

/** The refusal of a text filter on a list, naming the search that replaces it and any narrowing that search cannot apply. */
export function searchRepairRefusal(field: string, n: ListNarrowing): string {
  const { tool, ...args } = searchRepairCall(n);
  return `${searchRepairCause(field, n).replace(/\.?$/, '.')} Next call: ${tool} ${JSON.stringify(args)}; over HTTP, GET ${searchRepairPath(n)}.`;
}
