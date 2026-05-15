import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import {
  useDeleteProviderSecret,
  useProviderSecrets,
  useSaveProviderSecret,
} from '../../hooks/use-provider-secrets';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { ScopedField } from '../config/ScopedField';
import { ScopeBadge } from '../config/ScopePill';

type MonorepoReleaseMappingEntry = {
  path_glob: string;
  tag_pattern: string;
};

function parseStringList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function StringListTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string[] | undefined;
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const serialized = (value ?? []).join('\n');
  const [draft, setDraft] = useState(serialized);

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  return (
    <textarea
      className="min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-on-surface shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(parseStringList(draft))}
    />
  );
}

function parseMonorepoReleaseMapping(value: string): MonorepoReleaseMappingEntry[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pathGlob, tagPattern] = line.split(/\s*(?:=>|=)\s*/, 2);
      return {
        path_glob: pathGlob?.trim() ?? '',
        tag_pattern: tagPattern?.trim() ?? '',
      };
    })
    .filter((entry) => entry.path_glob && entry.tag_pattern);
}

function MonorepoReleaseMappingTextarea({
  value,
  onChange,
}: {
  value: MonorepoReleaseMappingEntry[] | undefined;
  onChange: (value: MonorepoReleaseMappingEntry[]) => void;
}) {
  const serialized = (value ?? [])
    .map((entry) => `${entry.path_glob} => ${entry.tag_pattern}`)
    .join('\n');
  const [draft, setDraft] = useState(serialized);

  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  return (
    <textarea
      className="min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-on-surface shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      value={draft}
      placeholder="packages/api/ => refs/tags/api/v*"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(parseMonorepoReleaseMapping(draft))}
    />
  );
}

function FieldNote({ children }: { children: string }) {
  return <p className="font-sans text-xs leading-5 text-on-surface-variant">{children}</p>;
}

function ReleaseSettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-outline-variant/20 pt-5">
      <div className="space-y-1">
        <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          {title}
        </h3>
        <FieldNote>{description}</FieldNote>
      </div>
      {children}
    </section>
  );
}

export function ReleaseProvenanceCard() {
  const { effective, setFields } = useScopedConfig();
  const { data: providerSecretsData } = useProviderSecrets();
  const saveProviderSecret = useSaveProviderSecret();
  const deleteProviderSecret = useDeleteProviderSecret();
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const repoName = effective?.release_provenance.github.repo.split('/').pop()?.replace(/\.git$/, '') || 'project';
  const projectTagRef = `refs/tags/${repoName}/v*`;
  const githubSecret = providerSecretsData?.secrets.github;
  const githubTokenStatus = githubSecret?.configured
    ? `${githubSecret.maskedValue ?? 'GitHub access'} connected for PR evidence.`
    : 'Required for private repos and reliable squash-merge matches.';

  const applyPreset = useCallback((productionRefs: string[], integrationRefs: string[]) => {
    void setFields([
      { path: 'release_provenance.production_refs', value: productionRefs },
      { path: 'release_provenance.integration_refs', value: integrationRefs },
    ], 'project').catch((err) => console.error('[settings] release provenance preset failed', err));
  }, [setFields]);

  const handleSaveGithubToken = useCallback(() => {
    const trimmed = githubTokenInput.trim();
    if (!trimmed) return;
    saveProviderSecret.mutate({ provider: 'github', apiKey: trimmed }, {
      onSuccess: () => setGithubTokenInput(''),
    });
  }, [githubTokenInput, saveProviderSecret]);

  const handleClearGithubToken = useCallback(() => {
    deleteProviderSecret.mutate({ provider: 'github' });
  }, [deleteProviderSecret]);

  return (
    <Surface level="low" className="rounded-lg p-6 space-y-6">
      <div className="max-w-4xl space-y-2">
        <SectionHeader>Release provenance</SectionHeader>
        <p className="font-sans text-sm text-on-surface-variant">
          Myco uses Git evidence to tell whether captured knowledge is released, merged but unreleased, or still only local.
        </p>
      </div>

      <ReleaseSettingsSection
        title="Release model"
        description="Define what counts as released and what counts as merged for this project."
      >
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(['refs/tags/v*'], ['origin/main'])}>
            Semver tags
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset([projectTagRef], ['origin/main'])}>
            Project tag family
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => applyPreset(['origin/main'], [])}>
            Main branch deploys
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ScopedField
            path="release_provenance.production_refs"
            label="Production refs"
            hint="one per line"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <StringListTextarea
                  value={value ?? []}
                  onChange={onChange}
                  placeholder="refs/tags/v*"
                />
                <FieldNote>Refs that mean code is released. Use release tags, project tag families, or the branch that deploys directly.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.integration_refs"
            label="Integration refs"
            hint="one per line"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <StringListTextarea
                  value={value ?? []}
                  onChange={onChange}
                  placeholder="origin/main"
                />
                <FieldNote>Refs that mean work is merged but not necessarily released. For GitHub projects this is usually the default branch.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="GitHub evidence"
        description="Optional PR evidence improves reconciliation when squash merges hide direct commit ancestry."
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,1fr)_12rem]">
          <ScopedField
            path="release_provenance.github.repo"
            label="Repository"
            hint="owner/name"
            lockScope="project"
            commitOn="blur"
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  value={value ?? ''}
                  placeholder="owner/name"
                  onChange={(event) => onChange(event.target.value)}
                  onBlur={onBlur}
                />
                <FieldNote>Detected from the GitHub remote when possible. Leave blank to disable GitHub PR evidence.</FieldNote>
              </div>
            )}
          </ScopedField>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="font-sans text-sm font-medium text-on-surface">Access token</label>
              <ScopeBadge scope="machine" />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="min-w-0 flex-1"
                type="password"
                value={githubTokenInput}
                placeholder={githubSecret?.configured ? 'Paste new GitHub token' : 'Paste GitHub token'}
                onChange={(event) => setGithubTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSaveGithubToken();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                onClick={handleSaveGithubToken}
                disabled={saveProviderSecret.isPending || githubTokenInput.trim() === ''}
              >
                {saveProviderSecret.isPending ? 'Saving' : githubSecret?.configured ? 'Update' : 'Connect'}
              </Button>
              {githubSecret?.configured && githubSecret.source !== 'env' && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleClearGithubToken}
                  disabled={deleteProviderSecret.isPending}
                >
                  Clear
                </Button>
              )}
            </div>
            <FieldNote>{githubTokenStatus}</FieldNote>
          </div>

          <ScopedField
            path="release_provenance.github.max_lookups_per_run"
            label="PR lookups"
            lockScope="project"
            commitOn="blur"
            parse={(value) => Number(value)}
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  type="number"
                  min={0}
                  max={200}
                  value={String(value ?? 20)}
                  onChange={(event) => onChange(Number(event.target.value))}
                  onBlur={onBlur}
                />
                <FieldNote>Maximum GitHub PR searches per reconcile run. Higher values can improve older squash-merge matches but use more API quota.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="Reconciliation behavior"
        description="Control whether provenance runs, how often it refreshes, and how unknown Git states are treated."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ScopedField
            path="release_provenance.enabled"
            label="Enabled"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <Switch checked={value ?? true} onCheckedChange={onChange} />
                <FieldNote>Enabled by default for Git projects. Missing refs leave records unreconciled instead of guessed.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.reconcile_interval_minutes"
            label="Reconcile interval"
            hint="minutes"
            defaultScope="project"
            commitOn="blur"
            parse={(value) => Number(value)}
          >
            {({ value, onChange, onBlur }) => (
              <div className="space-y-2">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={String(value ?? 15)}
                  onChange={(event) => onChange(Number(event.target.value))}
                  onBlur={onBlur}
                />
                <FieldNote>How often the daemon rechecks captured Git evidence against the release model.</FieldNote>
              </div>
            )}
          </ScopedField>

          <ScopedField
            path="release_provenance.production_debug_include_unknown"
            label="Include unknown debug"
            lockScope="project"
          >
            {({ value, onChange }) => (
              <div className="space-y-2">
                <Switch checked={value ?? true} onCheckedChange={onChange} />
                <FieldNote>Include dirty worktrees and other unknown Git states in production-scoped debug context.</FieldNote>
              </div>
            )}
          </ScopedField>
        </div>
      </ReleaseSettingsSection>

      <ReleaseSettingsSection
        title="Advanced monorepo releases"
        description="Use this only when different paths in one repository release through different tag families."
      >
        <ScopedField
          path="release_provenance.package_map"
          label="Monorepo release mapping"
          hint="path => release tag ref"
          lockScope="project"
        >
          {({ value, onChange }) => (
            <div className="space-y-2">
              <MonorepoReleaseMappingTextarea value={value ?? []} onChange={onChange} />
              <FieldNote>Map a path prefix to the tag pattern that releases that part of the repository.</FieldNote>
            </div>
          )}
        </ScopedField>
      </ReleaseSettingsSection>
    </Surface>
  );
}
