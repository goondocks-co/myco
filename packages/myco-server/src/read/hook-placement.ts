import { uuidv5 } from '../hash.js';

/** Canonical sub-agent identities carried by session-context records. */
export async function subagentContextIdentities<T extends { session_id: string; kind: string }>(rows: readonly T[]) {
  return Promise.all(rows.map(async row => ({ ...row, subagent_id: await uuidv5('subagent', row.session_id, row.kind.slice('cortex:'.length)) })));
}
