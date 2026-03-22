import { useState } from 'react';
import { SporeList } from '../components/mycelium/SporeList';
import { SporeDetail } from '../components/mycelium/SporeDetail';
import { GraphExplorer } from '../components/mycelium/GraphExplorer';
import { DigestView } from '../components/mycelium/DigestView';
import { cn } from '../lib/cn';
import type { SporeSummary } from '../hooks/use-spores';

/* ---------- Types ---------- */

type ActiveTab = 'spores' | 'graph' | 'digest';

/* ---------- Sub-components ---------- */

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Component ---------- */

export default function Mycelium() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('spores');
  const [selectedSpore, setSelectedSpore] = useState<SporeSummary | null>(null);

  function handleSelectSpore(spore: SporeSummary) {
    setSelectedSpore(spore);
  }

  function handleBackToList() {
    setSelectedSpore(null);
  }

  function handleNavigateToSpore(id: string) {
    // Update selectedSpore with a minimal stub — SporeDetail will fetch full data
    setSelectedSpore({ id } as SporeSummary);
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Mycelium</h1>
      <p className="text-sm text-muted-foreground -mt-2">
        Derived intelligence — spores, entity graph, and synthesized context.
      </p>

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-border">
        <TabButton active={activeTab === 'spores'} onClick={() => { setActiveTab('spores'); setSelectedSpore(null); }}>
          Spores
        </TabButton>
        <TabButton active={activeTab === 'graph'} onClick={() => setActiveTab('graph')}>
          Graph
        </TabButton>
        <TabButton active={activeTab === 'digest'} onClick={() => setActiveTab('digest')}>
          Digest
        </TabButton>
      </div>

      {/* Tab content */}
      {activeTab === 'spores' && (
        selectedSpore ? (
          <SporeDetail
            id={selectedSpore.id}
            onBack={handleBackToList}
            onNavigateToSpore={handleNavigateToSpore}
          />
        ) : (
          <SporeList
            onSelectSpore={handleSelectSpore}
          />
        )
      )}

      {activeTab === 'graph' && <GraphExplorer />}

      {activeTab === 'digest' && <DigestView />}
    </div>
  );
}
