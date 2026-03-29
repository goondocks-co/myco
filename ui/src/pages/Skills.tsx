import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '../components/ui/page-header';
import type { Tab } from '../components/ui/tab-switcher';

type SkillsTab = 'candidates' | 'skills';

/* ---------- URL state helpers ---------- */

const PARAM_TAB = 'tab';
const PARAM_SKILL = 'skill';

const VALID_TABS = new Set<SkillsTab>(['candidates', 'skills']);

function readUrlState(): { tab: SkillsTab; skill?: string } {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get(PARAM_TAB);
  const tab: SkillsTab =
    rawTab && VALID_TABS.has(rawTab as SkillsTab) ? (rawTab as SkillsTab) : 'candidates';
  return {
    tab,
    skill: params.get(PARAM_SKILL) ?? undefined,
  };
}

function writeUrlState(tab: SkillsTab, skill?: string): void {
  const params = new URLSearchParams();
  if (tab !== 'candidates') params.set(PARAM_TAB, tab);
  if (skill) params.set(PARAM_SKILL, skill);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

/* ---------- Tab definitions ---------- */

const TABS: Tab[] = [
  { id: 'candidates', label: 'Candidates' },
  { id: 'skills', label: 'Skills' },
];

/* ---------- Component ---------- */

export default function Skills() {
  const initial = readUrlState();
  const [tab, setTab] = useState<SkillsTab>(initial.tab);
  const [selectedSkill, setSelectedSkill] = useState<string | undefined>(initial.skill);

  // Sync URL whenever state changes
  useEffect(() => {
    writeUrlState(tab, selectedSkill);
  }, [tab, selectedSkill]);

  const switchTab = useCallback((id: string) => {
    const t = id as SkillsTab;
    setTab(t);
    if (t !== 'skills') setSelectedSkill(undefined);
  }, []);

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="Skills"
        subtitle="Discovered skill candidates and promoted skill records"
        tabs={TABS}
        activeTab={tab}
        onTabChange={switchTab}
      />

      {/* Candidates tab */}
      {tab === 'candidates' && (
        <div>
          {/* CandidateList will go here */}
        </div>
      )}

      {/* Skills tab */}
      {tab === 'skills' && (
        <div>
          {/* SkillList / SkillDetail will go here */}
        </div>
      )}
    </div>
  );
}
