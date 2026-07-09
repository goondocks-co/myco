import { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HelpCircle, ExternalLink } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { CapabilityIndicator } from '../components/config/CapabilityIndicator';
import { PageContainer } from '../components/ui/page-container';
import { TileTabs } from '../components/ui/tile-tabs';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '../components/ui/dialog';
import { CandidateList } from '../components/skills/CandidateList';
import { SkillList } from '../components/skills/SkillList';
import { SkillDetail } from '../components/skills/SkillDetail';
import { useSkillCandidates, useSkillRecords } from '../hooks/use-skills';

type SkillsTab = 'candidates' | 'skills';

/* ---------- URL state helpers ---------- */

const PARAM_TAB = 'tab';
const PARAM_SKILL = 'skill';

const VALID_TABS = new Set<SkillsTab>(['candidates', 'skills']);

function readUrlState(search: string): { tab: SkillsTab; skill?: string } {
  const params = new URLSearchParams(search);
  const rawTab = params.get(PARAM_TAB);
  const tab: SkillsTab =
    rawTab && VALID_TABS.has(rawTab as SkillsTab) ? (rawTab as SkillsTab) : 'skills';
  return {
    tab,
    skill: params.get(PARAM_SKILL) ?? undefined,
  };
}

function writeUrlState(tab: SkillsTab, skill?: string): void {
  const params = new URLSearchParams();
  if (tab !== 'skills') params.set(PARAM_TAB, tab);
  if (skill) params.set(PARAM_SKILL, skill);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

/* ---------- Tab definitions ---------- */

const TABS = [
  { id: 'skills', label: 'Skills', description: 'promoted records' },
  { id: 'candidates', label: 'Candidates', description: 'approval queue' },
] as const;

/* ---------- Help Dialog ---------- */

function SkillsHelpDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-on-surface-variant">
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>How Skills Work</DialogTitle>
          <DialogDescription>
            Skills are project-specific procedural guides generated from your vault knowledge.
            They teach agents how to accomplish tasks in your codebase.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 font-sans text-sm text-on-surface-variant">
          <div className="space-y-1.5">
            <h4 className="font-medium text-on-surface">The Pipeline</h4>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                <span className="font-medium text-on-surface">Survey</span> &mdash; discovers
                candidate skills from vault knowledge (sessions, decisions, gotchas)
              </li>
              <li>
                <span className="font-medium text-on-surface">Approve</span> &mdash; you
                review candidates and approve the ones worth generating
              </li>
              <li>
                <span className="font-medium text-on-surface">Generate</span> &mdash; produces
                a SKILL.md file from the approved candidate's source material
              </li>
              <li>
                <span className="font-medium text-on-surface">Evolve</span> &mdash; updates
                existing skills when new knowledge makes them stale
              </li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <h4 className="font-medium text-on-surface">Scheduling</h4>
            <p>
              <span className="font-medium text-on-surface">Skill Survey</span> runs
              automatically during idle periods. Skill Generate and Skill Evolve are
              off by default &mdash; enable them in the{' '}
              <Link to="/agent?tab=tasks" className="text-primary hover:underline inline-flex items-center gap-0.5">
                Agent Tasks
                <ExternalLink className="h-3 w-3" />
              </Link>{' '}
              page for fully automatic operation, or trigger them manually with Run Now.
            </p>
          </div>

          <div className="space-y-1.5">
            <h4 className="font-medium text-on-surface">Quick Start</h4>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Wait for the survey to discover candidates (or run it manually)</li>
              <li>Review candidates in the Candidates tab and approve the best ones</li>
              <li>
                Run{' '}
                <Link to="/agent?tab=tasks&task=skill-generate" className="text-primary hover:underline">
                  Skill Generate
                </Link>{' '}
                to produce skills from approved candidates
              </li>
            </ol>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- Component ---------- */

export default function Skills() {
  const location = useLocation();
  const initial = readUrlState(location.search);
  const [tab, setTab] = useState<SkillsTab>(initial.tab);
  const [selectedSkill, setSelectedSkill] = useState<string | undefined>(initial.skill);

  const { data: candidateData } = useSkillCandidates({ status: 'identified' });
  const { data: skillData } = useSkillRecords({ status: 'active' });
  const pendingCount = candidateData?.total ?? 0;
  const activeCount = skillData?.total ?? 0;

  // Sync URL whenever state changes
  useEffect(() => {
    writeUrlState(tab, selectedSkill);
  }, [tab, selectedSkill]);

  useEffect(() => {
    const state = readUrlState(location.search);
    setTab(state.tab);
    setSelectedSkill(state.skill);
  }, [location.search, location.key]);

  const switchTab = useCallback((id: string) => {
    const t = id as SkillsTab;
    setTab(t);
    if (t !== 'skills') setSelectedSkill(undefined);
  }, []);

  const selectSkill = useCallback((name: string) => {
    setTab('skills');
    setSelectedSkill(name);
  }, []);

  return (
    <PageContainer>
      <PageHeader
        title="Skills"
        subtitle="Discovered skill candidates and promoted skill records"
        actions={
          <div className="flex items-center gap-2">
            {pendingCount > 0 && <Badge variant="secondary">{pendingCount} pending</Badge>}
            {activeCount > 0 && <Badge variant="default">{activeCount} active</Badge>}
            <CapabilityIndicator capability="skills" />
            <SkillsHelpDialog />
          </div>
        }
      />

      <TileTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, description: t.description }))}
        activeTab={tab}
        onTabChange={switchTab}
        columns={2}
      />

      {/* Candidates tab */}
      {tab === 'candidates' && <CandidateList />}

      {/* Skills tab */}
      {tab === 'skills' && !selectedSkill && (
        <SkillList onSelectSkill={selectSkill} />
      )}

      {/* Skill detail */}
      {tab === 'skills' && selectedSkill && (
        <SkillDetail skillName={selectedSkill} onBack={() => setSelectedSkill(undefined)} />
      )}
    </PageContainer>
  );
}
