import type { MemberRig } from './server.js';

export const IMPORT_FAULTS = ['drop', 'ackloss', '403', '503ack', 'abortack'] as const;
export type ImportFault = typeof IMPORT_FAULTS[number];

export function faultAt(inner: MemberRig['fetch'], index: number, kind: ImportFault, persistent: boolean, controller: AbortController) {
  let requests = 0;
  const fetch: MemberRig['fetch'] = async (input, init) => {
    const request = new Request(input, init);
    requests += 1;
    if (requests < index || (!persistent && requests !== index)) return inner(request);
    if (kind === 'drop') throw new TypeError('fetch failed');
    if (kind === '403') return new Response('blocked', { status: 403 });
    await inner(request);
    if (kind === 'ackloss') throw new TypeError('fetch failed');
    if (kind === '503ack') return new Response('unavailable', { status: 503 });
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  };
  return { fetch, count: () => requests };
}

const VOLATILE = /(_at|_ms|At|Ms)$|^(id|key|value|generation|revision|envelope_hash|lineage_root|predecessor_id|reference_id|event_id|facts_event_id|.*_event_id|bundle_id|deployment_id|source_id|source_blob_key|source_generation|raw_revision)$|^(created|updated|received|first_received|last_received|ts|time)|token|expires|nonce|lease/i;

/** All server rows as sorted multisets, with generated identities and clock columns omitted. */
export function importSnapshot(sqlite: MemberRig['env']['sqlite']): Record<string, string[]> {
  const tables = sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'
    AND name NOT IN ('member_credentials','schema_meta','embedding_versions') ORDER BY name`).all() as Array<{ name: string }>;
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    const rows = sqlite.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) continue;
    out[name] = rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row)
      .filter(([key]) => !VOLATILE.test(key)).sort(([a], [b]) => a.localeCompare(b))))).sort();
  }
  out.lifecycle = sqlite.query('SELECT session_id, started_at, ended_at FROM sessions ORDER BY session_id').all().map((row) => JSON.stringify(row));
  return out;
}
