import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  projectPath,
  defaultSelection,
  selectionFromLast,
  selectionKey,
  setCurrentRequestSelection,
  writeLastSelection,
  type ProjectSelection,
} from '../lib/selection';
import { useGroves } from './use-groves';

const ProjectSelectionContext = createContext<ProjectSelection | null>(null);

export function ProjectSelectionBoundary({
  selection,
  children,
}: {
  selection: ProjectSelection;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const key = selectionKey(selection);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    setCurrentRequestSelection(selection);
    writeLastSelection(selection);
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== 'groves',
    });
    setActiveKey(key);
  }, [key, queryClient]);

  if (activeKey !== key) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-on-surface-variant">
        Switching project...
      </div>
    );
  }

  return (
    <ProjectSelectionContext.Provider value={selection}>
      {children}
    </ProjectSelectionContext.Provider>
  );
}

export function GlobalSelectionBoundary({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    setCurrentRequestSelection(null);
  }, []);
  return <>{children}</>;
}

export function useProjectSelection(): ProjectSelection | null {
  return useContext(ProjectSelectionContext);
}

/**
 * "Active project" resolver for surfaces that render at machine-scope
 * (e.g. /symbionts) but still need to act on a project — the per-project
 * Symbionts section, settings tied to the upper-left switcher, etc.
 *
 * Priority:
 *   1. The route-bound ProjectSelectionContext (if rendered under /g/:slug/p/:slug)
 *   2. The last-selected project from localStorage, resolved against the
 *      `['groves']` query cache populated by `useGroves`.
 *
 * Returns null when neither source resolves. This keeps the per-project
 * UI consistent regardless of which route the user navigated from.
 */
export function useActiveProjectSelection(): ProjectSelection | null {
  const ctx = useContext(ProjectSelectionContext);
  const groves = useGroves();
  if (ctx) return ctx;
  const list = groves.data?.groves ?? [];
  return selectionFromLast(list) ?? defaultSelection(list);
}

export function useProjectPath(suffix = ''): string {
  const selection = useProjectSelection();
  return selection ? projectPath(selection, suffix) : suffix || '/';
}

export function useProjectPathBuilder(): (suffix?: string) => string {
  const selection = useProjectSelection();
  return useCallback((suffix = '') => (
    selection ? projectPath(selection, suffix) : suffix || '/'
  ), [selection]);
}

/**
 * Append the project-selection marker to a query key so per-project caches
 * stay distinct. The marker goes at the END of the key: TanStack's partial
 * key matching is positional, so `invalidateQueries({ queryKey: ['ns', id] })`
 * only matches keys whose leading elements are `'ns', id`. Marker-last keeps
 * every namespace-shaped invalidation working; marker-at-index-1 silently
 * no-ops them.
 */
export function projectScopedQueryKey(
  selection: ProjectSelection | null,
  queryKey: QueryKey,
): QueryKey {
  if (!selection) return queryKey;
  return [...queryKey, { projectSelection: selectionKey(selection) }];
}

export function useProjectScopedQueryKey(queryKey: QueryKey): QueryKey {
  return projectScopedQueryKey(useProjectSelection(), queryKey);
}
