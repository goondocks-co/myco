import { type ReactNode } from 'react';
import { TabLinks } from '../../design';
import { CODE_MAP_SUFFIX, KNOWLEDGE_SUFFIX, PLANS_SUFFIX, projectPath } from '../../routes/nav';

/** Knowledge's sections, each at its own address. */
export type KnowledgeSection = 'spores' | 'plans' | 'map';

export interface KnowledgeFrameProps {
  /** The project the page is narrowed to, or null for every project. */
  projectId: string | null;
  /** The project's name, or null while the dashboard does not know it. */
  projectName: string | null;
  section: KnowledgeSection;
  children: ReactNode;
}

const LEDE: Readonly<Record<KnowledgeSection, (where: string | null) => string>> = {
  spores: (where) => `What Myco learned from your sessions${where === null ? ', across every project' : ` in ${where}`}. Each spore is written for your agents in one line.`,
  plans: (where) => `The plans your agents wrote${where === null ? ', across every project' : ` in ${where}`}, by how far each one got.`,
  map: (where) => `Where things live in ${where ?? 'this project'}’s code, and the files that carry each area.`,
};

/**
 * Knowledge: its title, one line on what the section holds, and the tabs
 * between spores, plans and, under a project, its code map. The code map is
 * drawn per project, so the page across every project has no such tab.
 */
export function KnowledgeFrame({ projectId, projectName, section, children }: KnowledgeFrameProps) {
  const base = projectId === null ? '' : projectPath(projectId);
  const where = projectId === null ? null : projectName ?? 'this project';
  const tabs = [
    { to: `${base}${KNOWLEDGE_SUFFIX}`, label: 'Spores', active: section === 'spores' },
    { to: `${base}${PLANS_SUFFIX}`, label: 'Plans', active: section === 'plans' },
    ...(projectId === null ? [] : [{ to: `${base}${CODE_MAP_SUFFIX}`, label: 'Code map', active: section === 'map' }]),
  ];
  return (
    <div className="flex w-full flex-col gap-s5" data-knowledge={section}>
      <header className="flex flex-col gap-s2">
        <h1 className="t-display text-ink">Knowledge</h1>
        <p className="max-w-measure t-body text-muted">{LEDE[section](where)}</p>
      </header>
      <TabLinks label="Knowledge sections" items={tabs} />
      {children}
    </div>
  );
}
