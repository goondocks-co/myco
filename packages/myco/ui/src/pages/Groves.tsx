import { useState } from 'react';
import { Plus } from 'lucide-react';
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
import { Panel } from '../components/ui/panel';
import { Row } from '../components/ui/row';
import { Eyebrow } from '../components/ui/eyebrow';
import { Badge } from '../components/ui/badge';
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
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <Eyebrow>Grove management</Eyebrow>
            <h1 className="myco-display-lg text-on-surface m-0">Groves</h1>
            <p className="font-sans text-sm text-on-surface-variant m-0">
              Registered local Grove projects for this daemon.
            </p>
          </div>
          <Button size="sm" onClick={() => setNewOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New Grove
          </Button>
        </header>

        <div className="flex flex-col gap-4">
          {groves.map((grove) => (
            <Panel
              key={grove.id}
              tone="sage"
              eyebrow="Grove"
              title={grove.name}
              actions={
                <div className="flex items-center gap-2">
                  {grove.is_default && <Badge variant="outline">default</Badge>}
                  <span className="font-mono text-[11px] text-on-surface-variant">
                    {grove.project_count} project{grove.project_count === 1 ? '' : 's'}
                  </span>
                  <GroveActionMenu
                    groveName={grove.name}
                    projectCount={grove.project_count}
                    isDefault={grove.is_default}
                    onRename={() => setRenameTarget(grove)}
                    onDelete={() => setDeleteTarget(grove)}
                    onSetDefault={() => handleSetDefault(grove)}
                  />
                </div>
              }
              padded={false}
            >
              {grove.projects.length === 0 ? (
                <p className="px-5 py-4 text-sm text-on-surface-variant">
                  No projects in this Grove.
                </p>
              ) : (
                <ul className="m-0 p-0 list-none">
                  {grove.projects.map((project) => (
                    <li key={project.project_id}>
                      <Row accent="sage">
                        <div className="flex items-center gap-3">
                          <NavLink
                            to={projectPath({ grove, project })}
                            className="flex min-w-0 flex-1 items-center gap-3 hover:text-sage"
                          >
                            <span
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
                              style={{ backgroundColor: colorForProjectId(project.project_id) }}
                            >
                              {monogramFor(project.name)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-on-surface">{project.name}</span>
                              <span className="block truncate text-xs text-on-surface-variant font-mono">{project.root}</span>
                            </span>
                            {project.manifest_state !== 'present' && (
                              <Badge variant="outline">{project.manifest_state}</Badge>
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
                      </Row>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
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
