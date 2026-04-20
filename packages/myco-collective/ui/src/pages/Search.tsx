import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { Button } from '../components/ui/button';
import { SearchFailureCard } from '../components/search/SearchFailureCard';
import { SearchInspector } from '../components/search/SearchInspector';
import { SearchResultCard } from '../components/search/SearchResultCard';
import { normalizeSearchResult } from '../components/search/model';
import { fetchProjects, runSearch } from '../lib/api';
import { titleCaseFromSnake } from '../lib/format';

const SELECT_BASE_CLASS = 'appearance-none h-9 w-full rounded-md border border-[var(--ghost-border)] bg-[var(--surface-container-lowest)] px-3 text-sm text-[var(--on-surface)] outline-hidden transition-colors focus:border-primary/40';

export default function Search() {
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [limit, setLimit] = useState('10');
  const [message, setMessage] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);

  const searchMutation = useMutation({
    mutationFn: runSearch,
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Search failed.');
    },
  });

  const groupedResults = useMemo(() => {
    const groups = new Map<string, ReturnType<typeof normalizeSearchResult>[]>();
    for (const [index, result] of (searchMutation.data?.results ?? []).entries()) {
      const normalized = normalizeSearchResult(result, index);
      const current = groups.get(normalized.projectName) ?? [];
      current.push(normalized);
      groups.set(normalized.projectName, current);
    }
    return Array.from(groups.entries());
  }, [searchMutation.data]);

  const flatResults = useMemo(() => groupedResults.flatMap(([, results]) => results), [groupedResults]);
  const selectedResult = flatResults.find((result) => result.key === selectedKey) ?? null;

  useEffect(() => {
    if (flatResults.length === 0) {
      setSelectedKey(null);
      setMobileInspectorOpen(false);
      return;
    }

    if (!selectedKey || !flatResults.some((result) => result.key === selectedKey)) {
      setSelectedKey(flatResults[0]?.key ?? null);
    }
  }, [flatResults, selectedKey]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setMobileInspectorOpen(false);
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
      <PageHeader
        eyebrow="Cross-Project Search"
        title="Search across teams without losing context."
        subtitle="Federated search stays in one workspace. Results remain grouped by project, and richer detail opens in-place so you can compare before you drill deeper."
      />

      <Card className="p-6">
        <form className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(220px,0.8fr)_96px_auto]" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Query</label>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="collective config split" required />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Project filter</label>
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className={SELECT_BASE_CLASS}
            >
              <option value="">All projects</option>
              {(projectsQuery.data?.projects ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Limit</label>
            <Input value={limit} onChange={(event) => setLimit(event.target.value)} placeholder="10" className="h-9" />
          </div>
          <div className="flex items-end">
            <Button type="submit" className="w-full xl:w-auto" disabled={searchMutation.isPending}>
              Run search
            </Button>
          </div>
        </form>
        {message && <p className="mt-4 text-sm text-tertiary">{message}</p>}
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <SearchFailureCard errors={searchMutation.data?.errors ?? []} />

          {groupedResults.length === 0 ? (
            <Card className="p-6">
              <SectionHeader>Search Results</SectionHeader>
              <div className="mt-3 text-base text-on-surface">
                {searchMutation.isPending ? 'Searching connected projects…' : 'Run a query to inspect cross-project results.'}
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-on-surface-variant">
                Results stay grouped by project. Selecting one opens a detail inspector without throwing away the current search context.
              </p>
            </Card>
          ) : (
            groupedResults.map(([projectName, results]) => (
              <Card key={projectName} className="p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <SectionHeader>{projectName}</SectionHeader>
                    <h2 className="mt-2 font-serif text-2xl text-on-surface">
                      {titleCaseFromSnake(projectName)}
                    </h2>
                  </div>
                  <div className="text-xs text-on-surface-variant">{results.length} result{results.length === 1 ? '' : 's'}</div>
                </div>

                <div className="mt-5 overflow-hidden rounded-md border border-[var(--ghost-border)] bg-surface-container-low">
                  {results.map((result) => (
                    <SearchResultCard
                      key={result.key}
                      result={result}
                      selected={result.key === selectedKey}
                      onSelect={() => {
                        setSelectedKey(result.key);
                        setMobileInspectorOpen(true);
                      }}
                    />
                  ))}
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="hidden xl:block">
          {selectedResult ? (
            <SearchInspector result={selectedResult} onClose={() => setSelectedKey(null)} />
          ) : (
            <Card className="sticky top-7 p-5">
              <SectionHeader>Result Detail</SectionHeader>
              <h3 className="mt-2 font-serif text-xl text-on-surface">Select a result</h3>
              <p className="mt-4 text-sm leading-6 text-on-surface-variant">
                Use the inspector to compare hits across projects, inspect metadata, and open raw record details only when needed.
              </p>
            </Card>
          )}
        </div>
      </div>

      {selectedResult && mobileInspectorOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-xs xl:hidden" onClick={() => setMobileInspectorOpen(false)} />
          <div className="fixed inset-x-0 bottom-0 top-16 z-50 overflow-hidden rounded-t-3xl border border-[var(--ghost-border)] xl:hidden">
            <SearchInspector
              result={selectedResult}
              onClose={() => setMobileInspectorOpen(false)}
              mobile
            />
          </div>
        </>
      )}
    </div>
  );
}
