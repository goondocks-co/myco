import { useState } from 'react';
import { ArrowLeft, AlertCircle, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { MarkdownContent } from '../ui/markdown-content';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { EvolutionTimeline } from './EvolutionTimeline';
import { useSkillRecord, useDeleteSkillRecord } from '../../hooks/use-skills';

/* ---------- Types ---------- */

interface SkillDetailProps {
  skillName: string;
  onBack: () => void;
}

/* ---------- Helpers ---------- */

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'stale') return 'secondary';
  return 'outline';
}

function parseSourceCount(sourceIds: string | null): number {
  if (!sourceIds) return 0;
  try {
    const parsed = JSON.parse(sourceIds);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/* ---------- Sub-components ---------- */

function SkeletonDetail() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-24 animate-pulse rounded bg-surface-container-high" />
      <div className="rounded-md bg-surface-container-low p-4 space-y-3">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-container-high" />
        <div className="h-4 w-64 animate-pulse rounded bg-surface-container-high" />
        <div className="h-5 w-32 animate-pulse rounded bg-surface-container-high" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-container-high" />
        ))}
      </div>
    </div>
  );
}

/* ---------- Component ---------- */

export function SkillDetail({ skillName, onBack }: SkillDetailProps) {
  const { data: skill, isPending, isError } = useSkillRecord(skillName);
  const deleteSkillRecord = useDeleteSkillRecord();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isPending) {
    return <SkeletonDetail />;
  }

  if (isError || !skill) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Skills
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Skill not found</span>
        </div>
      </div>
    );
  }

  const sourceCount = parseSourceCount(skill.source_ids);
  const rawContent = skill.lineage?.[0]?.content_snapshot ?? null;

  // Parse and strip YAML frontmatter
  const frontmatterMatch = rawContent?.match(/^---\n([\s\S]*?)\n---\n*/);
  const frontmatter: Record<string, string> = {};
  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (key && val && !['name', 'description', 'managed_by'].includes(key)) {
          frontmatter[key] = val;
        }
      }
    }
  }
  const latestContent = rawContent?.replace(/^---\n[\s\S]*?\n---\n*/, '') ?? null;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          Skills
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-tertiary hover:text-tertiary hover:bg-tertiary/10"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      {/* Header card */}
      <Surface level="low" className="p-4 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 space-y-1 min-w-0">
            <h1 className="font-serif text-lg text-on-surface">
              {skill.display_name}
            </h1>
            {skill.description && (
              <p className="font-sans text-sm text-on-surface-variant">{skill.description}</p>
            )}
            {skill.path && (
              <p className="font-mono text-[10px] text-on-surface-variant mt-1">{skill.path}</p>
            )}
            {Object.keys(frontmatter).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {frontmatter['user-invocable'] === 'true' && (
                  <Badge variant="secondary">user-invocable</Badge>
                )}
                {frontmatter['allowed-tools'] && (
                  <Badge variant="outline">
                    tools: {frontmatter['allowed-tools']}
                  </Badge>
                )}
              </div>
            )}
          </div>

          <Badge variant={statusBadgeVariant(skill.status)} className="shrink-0">
            {skill.status}
          </Badge>
        </div>
      </Surface>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Generation"
          value={`v${skill.generation}`}
          accent="sage"
        />
        <StatCard
          label="Usage"
          value={`${skill.usage_total ?? skill.usage_count ?? 0}`}
          sublabel="sessions"
          accent="ochre"
        />
        <StatCard
          label="Sources"
          value={`${sourceCount}`}
          accent="outline"
        />
      </div>

      {/* Evolution History */}
      <div className="space-y-3">
        <SectionHeader>Evolution History</SectionHeader>
        <EvolutionTimeline entries={skill.lineage ?? []} />
      </div>

      {/* Current Content — rendered inline, no scroll container */}
      <div className="space-y-3">
        <SectionHeader>Current Content</SectionHeader>
        {latestContent ? (
          <MarkdownContent content={latestContent} />
        ) : (
          <p className="font-sans text-sm text-on-surface-variant py-4">
            No content snapshot available.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Skill"
        description="This will permanently delete the skill record, evolution history, and the SKILL.md file from disk."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={skill ? [
          { label: 'Name', value: skill.name },
          { label: 'Title', value: skill.display_name },
        ] : []}
        confirmLabel="Delete Skill"
        variant="destructive"
        onConfirm={() => {
          deleteSkillRecord.mutate(skill!.name, {
            onSuccess: () => {
              setDeleteOpen(false);
              onBack();
            },
          });
        }}
        isPending={deleteSkillRecord.isPending}
      />
    </div>
  );
}
