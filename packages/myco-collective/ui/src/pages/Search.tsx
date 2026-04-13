import { useMutation, useQuery } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { fetchProjects, runSearch } from '../lib/api';
import type { SearchResultRecord } from '../lib/types';

function buildResultTitle(result: SearchResultRecord): string {
  const table = typeof result.table === 'string' ? result.table : 'result';
  const id = typeof result.id === 'string' ? result.id : 'unidentified';
  return `${table}:${id}`;
}

export default function Search() {
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [limit, setLimit] = useState('10');
  const [message, setMessage] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: runSearch,
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Search failed.');
    },
  });

  const groupedResults = useMemo(() => {
    const groups = new Map<string, SearchResultRecord[]>();
    for (const result of searchMutation.data?.results ?? []) {
      const projectName = result.project?.name ?? 'Unknown project';
      const current = groups.get(projectName) ?? [];
      current.push(result);
      groups.set(projectName, current);
    }
    return Array.from(groups.entries());
  }, [searchMutation.data]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    searchMutation.mutate({
      tool: 'collective_search',
      args: {
        query,
        project: project || undefined,
        limit: Number(limit) || 10,
      },
    });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-[#ceab91]">Cross-Project Search</p>
        <h2 className="mt-3 font-display text-4xl text-[#fff4e8] md:text-5xl">Fan out, attribute, and return partial results cleanly.</h2>
        <p className="mt-4 max-w-3xl text-base leading-7 text-[#cab3a2]">
          The Collective is expected to continue returning usable results even when some team workers are slow, missing, or incompatible. This view stays aligned with that contract and keeps project attribution visible on every hit.
        </p>
      </Card>

      <Card className="p-6">
        <form className="grid gap-4 lg:grid-cols-[2fr,1fr,120px,auto]" onSubmit={handleSubmit}>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search term or question" required />
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="h-11 rounded-2xl border border-[rgba(255,231,208,0.12)] bg-[rgba(255,248,240,0.05)] px-4 text-sm text-[#fff4e8] outline-none"
          >
            <option value="">All projects</option>
            {(projectsQuery.data?.projects ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
          <Input value={limit} onChange={(event) => setLimit(event.target.value)} placeholder="10" />
          <Button type="submit" disabled={searchMutation.isPending}>Run search</Button>
        </form>
        {message ? <p className="mt-3 text-sm text-[#d7c0ae]">{message}</p> : null}
      </Card>

      <div className="space-y-4">
        {(searchMutation.data?.errors?.length ?? 0) > 0 ? (
          <Card className="p-6">
            <h3 className="font-display text-2xl text-[#fff2e5]">Partial failures</h3>
            <div className="mt-4 space-y-3">
              {(searchMutation.data?.errors ?? []).map((error) => (
                <div key={`${error.project.id}-${error.error}`} className="rounded-[20px] border border-[rgba(255,180,160,0.16)] bg-[rgba(120,32,16,0.18)] p-4 text-sm text-[#ffd8cd]">
                  <p className="text-[#fff0e2]">{error.project.name}</p>
                  <p className="mt-1 break-all">{error.error}{error.status ? ` (status ${error.status})` : ''}</p>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
        {groupedResults.map(([projectName, results]) => (
          <Card key={projectName} className="p-6">
            <div className="flex items-center justify-between gap-4">
              <h3 className="font-display text-3xl text-[#fff2e5]">{projectName}</h3>
              <span className="rounded-full border border-[rgba(255,231,208,0.10)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-[#d2b29a]">
                {results.length} hits
              </span>
            </div>
            <div className="mt-5 grid gap-3">
              {results.map((result) => (
                <div key={`${projectName}-${buildResultTitle(result)}`} className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-lg text-[#fff0e2]">{buildResultTitle(result)}</p>
                      <p className="font-mono text-xs uppercase tracking-[0.22em] text-[#b79d8a]">
                        score {Number(result.score ?? 0).toFixed(3)}
                      </p>
                    </div>
                    <span className="rounded-full bg-[rgba(247,179,106,0.12)] px-3 py-1 text-xs text-[#ffd6ad]">
                      {result.project?.worker_url ?? 'unknown worker'}
                    </span>
                  </div>
                  <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-[22px] bg-[rgba(8,4,3,0.42)] p-4 font-mono text-xs text-[#ffe9d0]">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
