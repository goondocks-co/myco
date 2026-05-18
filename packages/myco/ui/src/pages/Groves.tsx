import { useState } from 'react';
import { FolderTree, Plus } from 'lucide-react';
import { useNavigate, NavLink } from 'react-router-dom';
import { useGroves } from '../hooks/use-groves';
import { useBackupProject, useSetDefaultGrove } from '../hooks/use-grove-mutations';
import {
  colorForProjectId,
  monogramFor,
  projectPath,
  type GroveSummary,
  type GroveProjectSummary,
} from '../lib/selection';
import { PageLoading } from '../components/ui/page-loading';
import { PageContainer } from '../components/ui/page-container';
import { Button } from '../components/ui/button';
import { GroveActionMenu } from '../components/groves/GroveActionMenu';
import { ProjectActionMenu } from '../components/groves/ProjectActionMenu';
import { NewGroveModal } from '../components/groves/NewGroveModal';
import { RenameGroveModal } from '../components/groves/RenameGroveModal';
import { DeleteGroveModal } from '../components/groves/DeleteGroveModal';
import { MoveProjectModal } from '../components/groves/MoveProjectModal';
import { showToast } from '../components/groves/toast';

interface MoveTarget {
  grove: GroveSummary;
  project: GroveProjectSummary;
}

export default function Groves() {
  const query = useGroves();
  const navigate = useNavigate();
  const backupProject = useBackupProject();
  const setDefaultGrove = useSetDefaultGrove();

  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GroveSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroveSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [pendingBackupId, setPendingBackupId] = useState<string | null>(null);

  const groves = query.data?.groves ?? [];

  function handleSetDefault(grove: GroveSummary) {
    setDefaultGrove.mutate(
      { id: grove.id },
      {
        onSuccess: () => {
          showToast({ level: 'success', title: `${grove.name} is now the default Grove` });
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Failed to set default', detail: err.message });
        },
      },
    );
  }

  function handleBackup(project: GroveProjectSummary) {
    setPendingBackupId(project.project_id);
    backupProject.mutate(
      { projectId: project.project_id },
      {
        onSuccess: (data) => {
          showToast({
            level: 'success',
            title: `Backup created for ${project.name}`,
            detail: data.snapshot_path,
          });
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Backup failed', detail: err.message });
        },
        onSettled: () => setPendingBackupId(null),
      },
    );
  }

  return (
    <PageLoading isLoading={query.isLoading} error={query.error} loadingText="Loading Groves...">
      <PageContainer>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FolderTree className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-on-surface">Groves</h1>
              <p className="text-sm text-on-surface-variant">Registered local Grove projects for this daemon.</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setNewOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New Grove
          </Button>
        </div>

        <div className="flex flex-col gap-4">
          {groves.map((grove) => (
            <section key={grove.id} className="border-t border-outline-variant/30 py-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-base font-semibold text-on-surface">{grove.name}</h2>
                {grove.is_default && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Default</span>
                )}
                <span className="text-xs text-on-surface-variant">{grove.project_count} projects</span>
                <div className="ml-auto">
                  <GroveActionMenu
                    groveName={grove.name}
                    projectCount={grove.project_count}
                    isDefault={grove.is_default}
                    onRename={() => setRenameTarget(grove)}
                    onDelete={() => setDeleteTarget(grove)}
                    onSetDefault={() => handleSetDefault(grove)}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {grove.projects.map((project) => (
                  <div
                    key={project.project_id}
                    className="flex items-center gap-3 rounded-md border border-outline-variant/30 bg-surface-container p-3 transition-colors hover:bg-surface-container-high"
                  >
                    <NavLink
                      to={projectPath({ grove, project })}
                      className="flex min-w-0 flex-1 items-center gap-3"
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
                    <ProjectActionMenu
                      projectName={project.name}
                      backupPending={pendingBackupId === project.project_id}
                      onOpen={() => navigate(projectPath({ grove, project }))}
                      onMove={() => setMoveTarget({ grove, project })}
                      onBackup={() => handleBackup(project)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </PageContainer>

      <NewGroveModal open={newOpen} onOpenChange={setNewOpen} />

      {renameTarget && (
        <RenameGroveModal
          open={renameTarget !== null}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          groveId={renameTarget.id}
          currentName={renameTarget.name}
        />
      )}

      {deleteTarget && (
        <DeleteGroveModal
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          groveId={deleteTarget.id}
          groveName={deleteTarget.name}
          projectCount={deleteTarget.project_count}
        />
      )}

      {moveTarget && (
        <MoveProjectModal
          open={moveTarget !== null}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          sourceGroveId={moveTarget.grove.id}
          projectId={moveTarget.project.project_id}
          projectName={moveTarget.project.name}
          groves={groves}
        />
      )}
    </PageLoading>
  );
}
