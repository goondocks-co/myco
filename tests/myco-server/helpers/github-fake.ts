/**
 * A modelled GitHub for release provenance tests: tags, which refs contain
 * which commits, and the pull requests that merged a commit. Paths the fake
 * does not model answer 500, so a test reaching one fails loudly.
 */
export const sha = (c: string) => c.repeat(40);
export const A = sha('a'); // in v1.2.0 (package a) and main
export const B = sha('b'); // in main only
export const C = sha('c'); // squashed: head diverged, merge commit M in v1.2.0
export const M = sha('d');
export const D = sha('e'); // on GitHub, in nothing
export const X = sha('f'); // in b/v2.0.0 only (package b)
export const MISSING = sha('9');

export interface Repo {
  tags: string[];
  /** ref -> commits it contains */
  contains: Record<string, string[]>;
  commits: string[];
  pulls: Record<string, Array<{ number: number; merged_at: string | null; merge_commit_sha: string; base: { ref: string } }>>;
  link?: string;
}

export const REPO: Repo = {
  tags: ['refs/tags/a/v1.1.0', 'refs/tags/a/v1.2.0', 'refs/tags/a/v1.2.0-rc.1', 'refs/tags/b/v2.0.0'],
  contains: {
    'refs/tags/a/v1.2.0': [A, M],
    'refs/tags/a/v1.1.0': [],
    'refs/tags/b/v2.0.0': [X],
    main: [A, B, M],
  },
  commits: [A, B, C, M, D, X],
  pulls: { [C]: [{ number: 7, merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: M, base: { ref: 'main' } }] },
};

export function fakeGithub(repo: Repo, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, ''));
    calls.push(path);
    const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
    if (path === '') return json({ default_branch: 'main' });
    const listing = /^\/git\/matching-refs\/(.+)$/.exec(path);
    if (listing) {
      const prefix = `refs/${listing[1]}`;
      return json(repo.tags.filter((t) => t.startsWith(prefix)).map((ref) => ({ ref, object: { sha: sha('0') } })), repo.link ? { link: repo.link } : {});
    }
    const head = /^\/git\/ref\/heads\/(.+)$/.exec(path);
    if (head) return head[1] in repo.contains ? json({ object: { sha: sha('1') } }) : new Response('{}', { status: 404 });
    const compare = /^\/compare\/([0-9a-f]{40})\.\.\.(.+)$/.exec(path);
    if (compare) {
      const [, commit, ref] = compare;
      if (!repo.commits.includes(commit) || !(ref in repo.contains)) return new Response('{}', { status: 404 });
      return json({ status: repo.contains[ref].includes(commit) ? 'ahead' : 'diverged' });
    }
    const pulls = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) return json(repo.pulls[pulls[1]] ?? []);
    const commit = /^\/commits\/([0-9a-f]{40})$/.exec(path);
    if (commit) return repo.commits.includes(commit[1]) ? json({ sha: commit[1] }) : new Response('{}', { status: 404 });
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
}

