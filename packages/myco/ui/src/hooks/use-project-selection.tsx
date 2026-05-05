import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  projectPath,
  selectionKey,
  setCurrentRequestSelection,
  writeLastSelection,
  type ProjectSelection,
} from '../lib/selection';

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

export function useProjectPath(suffix = ''): string {
  const selection = useProjectSelection();
  return selection ? projectPath(selection, suffix) : suffix || '/';
}
