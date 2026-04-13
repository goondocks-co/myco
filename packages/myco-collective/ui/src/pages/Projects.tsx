import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, PackagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { addProject, configureProject, deleteProject, fetchProjects } from '../lib/api';

function formatTimestamp(value: number | null): string {
  if (!value) return 'Never';
  return new Date(value * 1000).toLocaleString();
}

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

  return (
    <div className="space-y-6">
      <Card className="p-6 md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-[#ceab91]">Projects</p>
            <h2 className="mt-3 font-display text-4xl text-[#fff4e8] md:text-5xl">Register and wire team workers.</h2>
            <p className="mt-4 text-base leading-7 text-[#cdb7a7]">
              Registration is now coupled to remote worker configuration. If the Collective cannot finish the configure call, the project is not persisted as a half-attached record.
            </p>
          </div>
          <div className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[#9f8774]">Current count</p>
            <p className="mt-2 text-3xl text-[#fff1e3]">{projectsQuery.data?.projects.length ?? 0}</p>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-3">
          <PackagePlus className="h-5 w-5 text-[#f7b36a]" />
          <h3 className="font-display text-3xl text-[#fff2e5]">Add project</h3>
        </div>

        <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm text-[#ccb6a6]">Project name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Northwind" required />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-[#ccb6a6]">Worker URL</label>
            <Input value={workerUrl} onChange={(event) => setWorkerUrl(event.target.value)} placeholder="https://example.workers.dev" required />
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm text-[#ccb6a6]">Worker API key</label>
            <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Bearer token used by the team worker" required />
          </div>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={addMutation.isPending}>Register project</Button>
            {message ? <span className="text-sm text-[#d7c0ae]">{message}</span> : null}
          </div>
        </form>
      </Card>

      <div className="grid gap-4">
        {(projectsQuery.data?.projects ?? []).map((project) => (
          <Card key={project.id} className="p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <Cable className="h-5 w-5 text-[#f7b36a]" />
                  <h3 className="text-2xl text-[#fff1e3]">{project.name}</h3>
                </div>
                <p className="mt-3 break-all text-sm text-[#c4ad9c]">{project.worker_url}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {project.capabilities.map((capability) => (
                    <span key={capability} className="rounded-full border border-[rgba(255,231,208,0.09)] bg-[rgba(255,248,240,0.05)] px-3 py-1 text-xs text-[#ffd6ad]">
                      {capability}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 text-sm text-[#b89f8d]">
                <div>Package: {project.package_version ?? 'unknown'}</div>
                <div>Schema: {project.schema_version ?? 'unknown'}</div>
                <div>Last seen: {formatTimestamp(project.last_seen)}</div>
                <div>Registered: {formatTimestamp(project.registered_at)}</div>
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
                variant="danger"
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
