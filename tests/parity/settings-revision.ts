/** A settings route requires the revision its caller read: the If-Match a parity scenario sends with a settings write. */
export async function revisionHeaders(target: { url: string; ownerHeaders(): Record<string, string> }, path: string, body?: unknown,
  send: (request: Request) => Promise<Response> = fetch): Promise<Record<string, string>> {
  const read = async <T,>(route: string): Promise<T> => {
    const response = await send(new Request(`${target.url}${route}`, { headers: { ...target.ownerHeaders(), origin: target.url } }));
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const project = (body as { project_id?: unknown } | undefined)?.project_id;
  const leaf = /^\/api\/settings\/([^/?]+)/.exec(path)?.[1];
  const capability = /^\/api\/projects\/([^/]+)\/capabilities\/([^/?]+)/.exec(path);
  if (capability !== null) {
    const editor = await read<{ capabilityRevisions: Record<string, number> }>(`/api/projects/${capability[1]}/capabilities`);
    return { 'if-match': String(editor.capabilityRevisions[decodeURIComponent(capability[2]!)] ?? 0) };
  }
  if (leaf !== undefined && typeof project === 'string') {
    const editor = await read<{ revisions: Record<string, number> }>(`/api/projects/${project}/capabilities`);
    return { 'if-match': String(editor.revisions[decodeURIComponent(leaf)] ?? 0) };
  }
  const { leaves } = await read<{ leaves: Array<{ leaf: string; revision: string }> }>('/api/settings');
  const revisionOf = (name: string): number => Number(leaves.find(row => row.leaf === name)?.revision ?? 0);
  if (leaf !== undefined) return { 'if-match': String(revisionOf(decodeURIComponent(leaf))) };
  if (path === '/api/titling-backfill') return { 'if-match': String(revisionOf('agent.tasks')) };
  return { 'if-match': JSON.stringify(Object.fromEntries(['embedding.provider', 'embedding.model', 'embedding.base_url'].map(name => [name, revisionOf(name)]))) };
}
