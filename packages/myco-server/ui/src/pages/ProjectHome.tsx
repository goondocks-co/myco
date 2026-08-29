import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import { useProjects } from '../hooks/use-projects';
import { formatDateTime, formatRelative } from '../lib/format';
import { forgetProject, rememberProject } from '../lib/project-memory';
import { NotFound } from './NotFound';

export function ProjectHome() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.projects.find((p) => p.projectId === projectId);

  useEffect(() => {
    if (project) rememberProject(project.projectId);
    else if (projects.data) forgetProject();
  }, [project, projects.data]);

  if (!project) return <NotFound />;

  return (
    <PageContainer>
      <PageHeader title={project.name} subtitle={project.projectId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Sessions" value={project.sessionCount.toLocaleString()} accent="sage" />
        <StatCard label="Last activity" value={formatRelative(project.lastActivityAt)} sublabel={formatDateTime(project.lastActivityAt)} accent="ochre" />
        <StatCard label="Connected" value={formatRelative(project.createdAt)} sublabel={formatDateTime(project.createdAt)} accent="outline" />
      </div>
      <p className="mt-6 font-sans text-sm text-on-surface-variant">
        Sessions for this project are on their way.
      </p>
    </PageContainer>
  );
}
