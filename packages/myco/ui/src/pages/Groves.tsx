import { FolderTree } from 'lucide-react';
import { useGroves } from '../hooks/use-groves';
import { colorForProjectId, monogramFor, projectPath } from '../lib/selection';
import { PageLoading } from '../components/ui/page-loading';
import { NavLink } from 'react-router-dom';

export default function Groves() {
  const query = useGroves();
  return (
    <PageLoading isLoading={query.isLoading} error={query.error} loadingText="Loading Groves...">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FolderTree className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-on-surface">Groves</h1>
            <p className="text-sm text-on-surface-variant">Registered local Grove projects for this daemon.</p>
          </div>
        </div>

        <div className="space-y-4">
          {(query.data?.groves ?? []).map((grove) => (
            <section key={grove.id} className="border-t border-outline-variant/30 py-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-base font-semibold text-on-surface">{grove.name}</h2>
                {grove.is_default && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Default</span>
                )}
                <span className="text-xs text-on-surface-variant">{grove.project_count} projects</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {grove.projects.map((project) => (
                  <NavLink
                    key={project.project_id}
                    to={projectPath({ grove, project })}
                    className="flex items-center gap-3 rounded-md border border-outline-variant/30 bg-surface-container p-3 transition-colors hover:bg-surface-container-high"
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
                      style={{ backgroundColor: colorForProjectId(project.project_id) }}
                    >
                      {monogramFor(project.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-on-surface">{project.name}</span>
                      <span className="block truncate text-xs text-on-surface-variant">{project.root}</span>
                    </span>
                    {project.manifest_state !== 'present' && (
                      <span className="rounded-full bg-tertiary/10 px-2 py-0.5 text-xs text-tertiary">
                        {project.manifest_state}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PageLoading>
  );
}
