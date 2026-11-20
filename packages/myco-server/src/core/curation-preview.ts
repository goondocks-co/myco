import type { ServerEnv } from './adapters.js';
import type { TaskInput } from './task-inputs.js';
import { getRun } from '../db/runs/lifecycle.js';
import { readCurationWork, type CurationSeedMember } from '../db/spores/curation-work.js';
import { readCurationPassStart, readCurationProjectState, readCurationSeeds } from '../db/spores/curation-discovery.js';
import { resolveSemanticSearch } from './search.js';
import { curationAssignment, curationClusterKey, curationMaterial, CURATION_SEEDS_PER_TICK, selectCurationGroup } from './spore-curation.js';

export const CURATION_PREVIEW_PAGES = 4;
/** How many note ids a preview sitting remembers as shown; past it the earliest shown are forgotten first. */
const CURATION_PREVIEW_SHOWN_IDS = 128;
const CONTINUATION_ID_CHARS = 512;
const CONTINUATION_VERSION = 2;
type Position = Parameters<typeof readCurationSeeds>[2];
export interface CurationContinuation { version: typeof CONTINUATION_VERSION; projectId: string; position: Position; shown: string[] }
export class InvalidCurationContinuation extends Error {
  constructor() { super('Invalid curation continuation: use the continuation returned for this Project, or omit continuation to start again. No preview was started.'); }
}

const boundedId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= CONTINUATION_ID_CHARS;

/** A continuation admits only one Project, a bounded forward seed position and a bounded list of distinct shown note ids. */
function continuationOf(value: unknown, projectId: string): CurationContinuation | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new InvalidCurationContinuation();
  const held = value as Partial<CurationContinuation>;
  const { position, shown } = held;
  const numbers = ['after_at', 'priority_at', 'history_at'] as const;
  const ids = ['after_id', 'history_id'] as const;
  if (held.version !== CONTINUATION_VERSION || held.projectId !== projectId || position === null || typeof position !== 'object' || Array.isArray(position)
    || Object.keys(held).length !== 4 || Object.keys(position).length !== numbers.length + ids.length
    || numbers.some(key => !Number.isSafeInteger(position[key]) || position[key] < 0)
    || ids.some(key => typeof position[key] !== 'string' || position[key].length > CONTINUATION_ID_CHARS)
    || position.priority_at > 0 && position.history_at > position.priority_at
    || !Array.isArray(shown) || shown.length > CURATION_PREVIEW_SHOWN_IDS || !shown.every(boundedId) || new Set(shown).size !== shown.length) throw new InvalidCurationContinuation();
  return { version: CONTINUATION_VERSION, projectId, position, shown };
}

/** The place after `position`, remembering `members` as shown after what was shown before, the latest kept within the bound. */
function continueAfter(projectId: string, position: Position, shown: readonly string[], members: readonly string[] = []): CurationContinuation {
  const held = [...shown.filter(id => !members.includes(id)), ...members].slice(-CURATION_PREVIEW_SHOWN_IDS);
  return { version: CONTINUATION_VERSION, projectId, shown: held, position: {
    after_at: position.after_at, after_id: position.after_id, priority_at: position.priority_at, history_at: position.history_at, history_id: position.history_id,
  } };
}

const idsOf = (members: readonly { id: string }[]): string[] => members.map(member => member.id);

export interface CurationPreview {
  outcome: 'group_found' | 'no_qualifying_group' | 'vectors_pending';
  input: TaskInput | null;
  continuation: CurationContinuation | null;
}

/** At most four seed pages; all progress belongs to the returned continuation. */
export async function discoverCurationPreview(env: ServerEnv, options: {
  projectId: string; now: number; group?: string; continuation?: unknown;
}): Promise<CurationPreview> {
  const { projectId, now, group } = options;
  const continuation = continuationOf(options.continuation, projectId);
  const empty = (outcome: CurationPreview['outcome'] = 'no_qualifying_group', next = continuation): CurationPreview => ({ outcome, input: null, continuation: next });
  const state = await readCurationProjectState(env.db, projectId, now);
  if (state.frontier === null) return empty('no_qualifying_group', null);
  const existing = group === undefined ? continuation === null ? state.open : null : await readCurationWork(env.db, projectId, group);
  if (existing?.decision === null) {
    const seeds = JSON.parse(existing.members) as CurationSeedMember[];
    const built = await curationMaterial(env, { projectId, key: existing.cluster_key, seeds, preview: true });
    const position = continuation?.position ?? state.cursor ?? await readCurationPassStart(env.db, { project: projectId, start: Math.max(0, state.frontier.pending_at ?? 0), revision: state.frontier.revision });
    if (!('input' in built)) return empty();
    return { outcome: 'group_found', input: built.input, continuation: position === null ? null : continueAfter(projectId, position, continuation?.shown ?? [], idsOf(built.members)) };
  }
  if (group !== undefined) return empty();
  const semantic = await resolveSemanticSearch(env);
  if (semantic === null) return empty();
  let cursor = continuation?.position ?? (state.cursor?.active === 1 ? state.cursor : await readCurationPassStart(env.db, {
    project: projectId, start: Math.max(0, state.frontier.pending_at ?? 0), revision: state.frontier.revision,
  }));
  if (cursor === null) return empty('no_qualifying_group', null);
  const shown = continuation?.shown ?? [];
  let visited = 0, pending = 0;
  for (let page = 0; page < CURATION_PREVIEW_PAGES; page++) {
    const seeds = await readCurationSeeds(env.db, projectId, cursor, CURATION_SEEDS_PER_TICK);
    if (seeds.length === 0) return empty(visited > 0 && pending === visited ? 'vectors_pending' : 'no_qualifying_group', null);
    let found = null as { input: TaskInput; members: readonly { id: string }[] } | null;
    const selection = await selectCurationGroup(env, { projectId, now, semantic, cursor, seeds, pending: 'skip',
      consider: async () => {},
      offer: async members => {
        const built = await curationMaterial(env, { projectId, key: await curationClusterKey(members), seeds: members, preview: true });
        if (!('input' in built) || built.members.every(member => shown.includes(member.id))) return false;
        found = built;
        return true;
      },
    });
    visited += selection.visited;
    pending += selection.pendingSeeds;
    cursor = { ...cursor, after_at: selection.last.stamp, after_id: selection.last.id,
      ...(cursor.priority_at > 0 && selection.last.stamp < cursor.priority_at ? { history_at: selection.last.stamp, history_id: selection.last.id } : {}),
    };
    if (found !== null) return { outcome: 'group_found', input: found.input, continuation: continueAfter(projectId, cursor, shown, idsOf(found.members)) };
    const next = continueAfter(projectId, cursor, shown);
    if (seeds.length < CURATION_SEEDS_PER_TICK) return empty(pending === visited ? 'vectors_pending' : 'no_qualifying_group', null);
    if (page === CURATION_PREVIEW_PAGES - 1) return empty(pending === visited ? 'vectors_pending' : 'no_qualifying_group', next);
  }
  throw new Error('Curation preview requires a positive page budget');
}

/** A queued preview keeps the assignment selected at admission. */
export async function buildStoredCurationPreview(env: ServerEnv, { projectId, runId, now, group }: { projectId: string; runId: string; now: number; group?: string }): Promise<TaskInput | null> {
  const run = await getRun(env.db, { projectId }, runId);
  const assignment = curationAssignment(run?.runContext ?? null);
  if (assignment === null) return (await discoverCurationPreview(env, { projectId, now, group })).input;
  const built = await curationMaterial(env, { projectId, key: assignment.key,
    seeds: assignment.members.map(member => ({ ...member, closeness: 0 })), preview: true });
  return 'input' in built ? built.input : null;
}
