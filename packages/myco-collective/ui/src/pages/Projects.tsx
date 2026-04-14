import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, PackagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { addProject, configureProject, deleteProject, fetchProjects } from '../lib/api';
import { formatTimestamp } from '../lib/format';

export default function Projects() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [name, setName] = useState('');
  const [workerUrl, setWorkerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const refreshProjects = async () => {
    await queryClient.invalidateQueries({ queryKey: ['projects'] });
    await queryClient.invalidateQueries({ queryKey: ['health'] });
  };

  const addMutation = useMutation({
    mutationFn: addProject,
    onSuccess: async () => {
      setMessage('Project registered and configured.');
      setName('');
      setWorkerUrl('');
      setApiKey('');
      await refreshProjects();
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Failed to add project.');
    },
  });

  const configureMutation = useMutation({
    mutationFn: configureProject,
    onSuccess: async () => {
      setMessage('Project reconfigured.');
      await refreshProjects();
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Failed to reconfigure project.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async () => {
      setMessage('Project removed.');
      await refreshProjects();
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : 'Failed to remove project.');
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    addMutation.mutate({ name, worker_url: workerUrl, api_key: apiKey });
  };

  const projects = projectsQuery.data?.projects ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Projects"
        title="Register and manage connected team workers."
        subtitle="Registration and remote configuration stay paired so the Collective never persists half-attached project records."
        actions={<Badge variant="subtle">{projects.length} connected</Badge>}
      />

      <Card className="p-6">
        <div className="flex items-center gap-3">
          <PackagePlus className="h-5 w-5 text-primary" />
          <div>
            <SectionHeader>Add Project</SectionHeader>
            <h2 className="mt-2 font-serif text-2xl text-on-surface">Attach a new worker</h2>
          </div>
        </div>

        <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Project name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Northwind" required />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-on-surface-variant">Worker URL</label>
            <Input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="https://example.workers.dev" required />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-xs text-on-surface-variant">Worker API key</label>
            <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bearer token used by the team worker" required />
          </div>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={addMutation.isPending}>Register project</Button>
            {message && <span className="text-sm text-on-surface-variant">{message}</span>}
          </div>
        </form>
      </Card>

      <div className="grid gap-4">
        {projects.map((project) => (
          <Card key={project.id} className="p-6">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <Cable className="h-5 w-5 text-primary" />
                  <h3 className="text-xl text-on-surface">{project.name}</h3>
                </div>
                <p className="mt-3 break-all text-sm text-on-surface-variant">{project.worker_url}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {project.capabilities.map((capability) => (
                    <Badge key={capability} variant="subtle">
                      {capability}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="grid shrink-0 gap-1 text-sm text-on-surface-variant xl:text-right">
                <div>Package {project.package_version ?? 'unknown'}</div>
                <div>Schema {project.schema_version ?? 'unknown'}</div>
                <div>Last seen {formatTimestamp(project.last_seen)}</div>
                <div>Registered {formatTimestamp(project.registered_at)}</div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => configureMutation.mutate(project.id)}
                disabled={configureMutation.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Reconfigure
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(project.id)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
