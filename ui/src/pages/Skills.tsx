import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '../components/ui/page-header';
import type { Tab } from '../components/ui/tab-switcher';
import { Badge } from '../components/ui/badge';
import { CandidateList } from '../components/skills/CandidateList';
import { SkillList } from '../components/skills/SkillList';
import { SkillDetail } from '../components/skills/SkillDetail';
import { useSkillCandidates, useSkillRecords } from '../hooks/use-skills';

type SkillsTab = 'candidates' | 'skills';

/* ---------- URL state helpers ---------- */

const PARAM_TAB = 'tab';
const PARAM_SKILL = 'skill';

const VALID_TABS = new Set<SkillsTab>(['candidates', 'skills']);

function readUrlState(): { tab: SkillsTab; skill?: string } {
  const params = new URLSearchParams(window.location.search);
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

const TABS: Tab[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'candidates', label: 'Candidates' },
];

/* ---------- Component ---------- */

export default function Skills() {
  const initial = readUrlState();
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
    <div className="p-6 space-y-4">
      <PageHeader
        title="Skills"
        subtitle="Discovered skill candidates and promoted skill records"
        tabs={TABS}
        activeTab={tab}
        onTabChange={switchTab}
        actions={
          <div className="flex items-center gap-2">
            {pendingCount > 0 && <Badge variant="secondary">{pendingCount} pending</Badge>}
            {activeCount > 0 && <Badge variant="default">{activeCount} active</Badge>}
          </div>
        }
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
    </div>
  );
}
