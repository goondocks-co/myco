/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Search, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import type { SettingScope } from '../../settings/manifest';
import { cn } from '../../lib/cn';

export type ScopeFilter = 'all' | SettingScope;

interface SettingsFilterBarProps {
  scope: ScopeFilter;
  onScopeChange: (scope: ScopeFilter) => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  scopeCounts: Record<SettingScope, number>;
}

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'grove', label: 'Grove' },
  { value: 'machine', label: 'Machine' },
];

export function SettingsFilterBar({
  scope,
  onScopeChange,
  searchInput,
  onSearchChange,
  scopeCounts,
}: SettingsFilterBarProps) {
  const totalCount = scopeCounts.project + scopeCounts.grove + scopeCounts.machine;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div
        role="tablist"
        aria-label="Filter settings by scope"
        className="inline-flex overflow-hidden rounded-md border border-[var(--ghost-border)] bg-surface-container-low"
      >
        {SCOPE_OPTIONS.map((opt) => {
          const count = opt.value === 'all' ? totalCount : scopeCounts[opt.value];
          const active = opt.value === scope;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onScopeChange(opt.value)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40',
                active
                  ? 'bg-sage/10 text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-[2px] bg-sage"
                />
              )}
              <span className={cn('myco-display-xs', !active && 'text-on-surface-variant')}>
                {opt.label}
              </span>
              <Badge variant="outline" className="px-1 py-0 text-[10px] font-mono">{count}</Badge>
            </button>
          );
        })}
      </div>
      <div className="relative flex-1 min-w-[16rem] max-w-md">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
        <Input
          type="search"
          value={searchInput}
          placeholder="Search settings..."
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 pr-8"
        />
        {searchInput && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 text-on-surface-variant hover:bg-surface-container-high/40 hover:text-on-surface"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
