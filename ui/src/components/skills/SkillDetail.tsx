import { ArrowLeft, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { SectionHeader } from '../ui/section-header';
import { MarkdownContent } from '../ui/markdown-content';
import { EvolutionTimeline } from './EvolutionTimeline';
import { useSkillRecord } from '../../hooks/use-skills';

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
  const latestContent = skill.lineage?.[0]?.content_snapshot ?? null;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
        <ArrowLeft className="h-4 w-4" />
        Skills
      </Button>

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

      {/* Current Content */}
      <div className="space-y-3">
        <SectionHeader>Current Content</SectionHeader>
        {latestContent ? (
          <Surface level="lowest" className="p-4 overflow-auto max-h-[32rem]">
            <MarkdownContent content={latestContent} />
          </Surface>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant py-4">
            No content snapshot available.
          </p>
        )}
      </div>
    </div>
  );
}
