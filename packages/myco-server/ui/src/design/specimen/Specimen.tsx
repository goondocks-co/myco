import { useEffect, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { ApiError } from '../../lib/api';
import {
  Avatar, Button, Card, CommandBlock, ConfirmDialog, CopyButton, DayGroup, Dialog, DialogContent, DialogFooter, DialogTrigger,
  Disclosure, EmptyState, ErrorState, FactRow, FactsPanel, FilterBar, HealthDot, IconButton, Input, Kbd, Link, ListRow,
  LoadingState, MoreMenu, SearchableSelect, SearchInput, Select, ShowMore, Stat, StatusChip, Switch, Tabs, TabsContent,
  TabsList, TabsTrigger, Textarea, TypeChip,
} from '../index';

const SURFACES = ['page', 'bg', 'surface-1', 'surface-2', 'surface-3', 'line', 'line-strong'] as const;
const INKS = ['ink', 'ink-2', 'muted', 'faint', 'primary'] as const;
const STATES = ['ok', 'warn', 'bad'] as const;
const SWATCH: Record<string, string> = {
  page: 'bg-page', bg: 'bg-bg', 'surface-1': 'bg-surface-1', 'surface-2': 'bg-surface-2', 'surface-3': 'bg-surface-3',
  line: 'bg-line', 'line-strong': 'bg-line-strong',
};
const INK_TEXT: Record<string, string> = { ink: 'text-ink', 'ink-2': 'text-ink-2', muted: 'text-muted', faint: 'text-faint', primary: 'text-primary' };
const STATE_CHIP: Record<string, string> = { ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', bad: 'bg-bad-bg text-bad' };

const TYPE_SCALE = [
  ['t-display', 'Tuesday, September 29', 'Newsreader italic 600 · 28/1.15'],
  ['t-h2', 'Needs you', 'Newsreader italic 600 · 20/1.2'],
  ['t-h3', 'Capture on the studio machine', 'Newsreader italic 600 · 16/1.3'],
  ['t-body', 'Recency is the selector; the summary leads the page and the conversation follows it.', 'Inter 400 · 15/1.55'],
  ['t-small', 'Claude Code · 42 minutes · 18 prompts', 'Inter 400 · 13.5/1.45'],
  ['t-control', 'Show more', 'Inter · 14/1.25, labels inside controls'],
  ['t-meta', '4 h ago', 'Inter 400 · 12/1.4'],
  ['t-kicker', 'Projects', 'Inter 500 · 12, tracked, uppercase'],
  ['t-mono', 'myco login https://example.test/join', 'JetBrains Mono · 13/1.5'],
] as const;

const SPACES = [['s-1', 'w-s1'], ['s-2', 'w-s2'], ['s-3', 'w-s3'], ['s-4', 'w-s4'], ['s-5', 'w-s5'], ['s-6', 'w-s6'], ['s-8', 'w-s8'], ['s-10', 'w-s10'], ['s-12', 'w-s12']] as const;

const AGENTS = [
  { value: 'all', label: 'Every agent' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
];
const WINDOWS = [
  { value: 'all', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
];
const PROJECTS = ['myco', 'canopy-sandbox', 'docs site', 'field notes', 'harness lab', 'home lab', 'photo tools', 'reading list', 'recipes', 'scratch', 'trip planner', 'web app']
  .map((name) => ({ value: name.replace(/\s+/g, '-'), label: name }));

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-s4 border-t border-line pt-s8">
      <div className="flex flex-col gap-s2">
        <span className="t-kicker text-faint">{kicker}</span>
        <h2 id={id} className="t-h2 text-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="t-meta text-muted">{children}</span>;
}

/** Every token and component of the design system on one page, in the current theme and mode. */
export function Specimen() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({ agent: 'all', window: 'today' });
  const [agent, setAgent] = useState('claude-code');
  const [project, setProject] = useState('myco');
  const [learning, setLearning] = useState(true);
  const [titling, setTitling] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { document.documentElement.dataset.ready = '1'; }, []);

  return (
    <div className="min-h-screen bg-bg text-ink">
      <a href="#specimen-main" className="sr-only focus:not-sr-only focus:absolute focus:left-s4 focus:top-s4 focus:rounded-control focus:bg-surface-1 focus:px-s3 focus:py-s2 t-control">
        Skip to content
      </a>
      <main id="specimen-main" className="mx-auto flex max-w-[1120px] flex-col gap-s10 px-gutter py-s10">
        <header className="flex flex-col gap-s2">
          <span className="t-kicker text-faint">Myco dashboard</span>
          <h1 className="t-display text-ink">Design system</h1>
          <p className="max-w-[var(--measure)] t-body text-ink-2">
            Semantic tokens, a type scale that never drops below 12px, a 4px spacing base and one page gutter, and the
            components every page is built from. Accents mark state; they never decorate.
          </p>
        </header>

        <Section id="colour" kicker="Tokens" title="Colour">
          <div className="grid grid-cols-2 gap-s3 sm:grid-cols-4 lg:grid-cols-7">
            {SURFACES.map((name) => (
              <div key={name} className="flex flex-col gap-s2">
                <span className={`h-s12 rounded-control border border-line-strong ${SWATCH[name]}`} />
                <Label>--{name}</Label>
              </div>
            ))}
          </div>
          <Card className="flex flex-wrap gap-x-s8 gap-y-s3">
            {INKS.map((name) => <span key={name} className={`t-body ${INK_TEXT[name]}`}>--{name}</span>)}
          </Card>
          <div className="flex flex-wrap gap-s3">
            {STATES.map((name) => <span key={name} className={`rounded-chip px-s3 py-s1 t-small font-medium ${STATE_CHIP[name]}`}>--{name} on --{name}-bg</span>)}
          </div>
        </Section>

        <Section id="type" kicker="Tokens" title="Type">
          <Card padding="flush" className="divide-y divide-line">
            {TYPE_SCALE.map(([token, sample, spec]) => (
              <div key={token} className="flex flex-col gap-s1 px-s4 py-s3 sm:flex-row sm:items-baseline sm:gap-s6">
                <span className="w-[120px] shrink-0 t-mono text-muted">{token}</span>
                <span className={`min-w-0 flex-1 ${token} text-ink`}>{sample}</span>
                <span className="shrink-0 t-meta text-faint">{spec}</span>
              </div>
            ))}
          </Card>
        </Section>

        <Section id="space" kicker="Tokens" title="Spacing, radius and density">
          <div className="flex flex-wrap items-end gap-s4">
            {SPACES.map(([name, width]) => (
              <div key={name} className="flex flex-col items-start gap-s2">
                <span className={`h-s6 rounded-chip bg-primary ${width}`} />
                <Label>{name}</Label>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-s4">
            {[['chip', 'rounded-chip'], ['control', 'rounded-control'], ['card', 'rounded-card'], ['pill', 'rounded-pill']].map(([name, radius]) => (
              <div key={name} className="flex flex-col items-start gap-s2">
                <span className={`size-s12 border border-line-strong bg-surface-2 ${radius}`} />
                <Label>--r-{name}</Label>
              </div>
            ))}
            <div className="flex flex-col items-start gap-s2">
              <span className="flex h-row w-[160px] items-center rounded-control border border-dashed border-line-strong px-s3 t-meta text-muted">--row</span>
              <Label>row height, set by density</Label>
            </div>
          </div>
        </Section>

        <Section id="buttons" kicker="Primitives" title="Buttons">
          <div className="flex flex-wrap items-center gap-s3">
            <Button variant="primary">Run a task</Button>
            <Button>Edit repository</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete session</Button>
            <Button variant="primary" pending>Saving</Button>
            <Button disabled>Disabled</Button>
            <IconButton label="Start"><Play aria-hidden className="size-s4" /></IconButton>
          </div>
          <div className="flex flex-wrap items-center gap-s3">
            <Button variant="primary" size="sm">Small primary</Button>
            <Button size="sm">Small</Button>
            <Button variant="ghost" size="sm">Small ghost</Button>
            <CopyButton value="sess_example" label="Copy id" />
          </div>
        </Section>

        <Section id="fields" kicker="Primitives" title="Fields, selects and switches">
          <div className="grid gap-s4 sm:grid-cols-2">
            <label className="flex flex-col gap-s1 t-small text-ink-2">
              Branch
              <Input defaultValue="main" />
            </label>
            <label className="flex flex-col gap-s1 t-small text-ink-2">
              Read token
              <Input type="password" placeholder="Leave blank to keep the current credential" />
            </label>
            <div className="flex flex-col gap-s1 t-small text-ink-2">
              <span>Agent</span>
              <Select label="Agent" value={agent} onValueChange={setAgent} options={AGENTS.slice(1)} />
            </div>
            <div className="flex flex-col gap-s1 t-small text-ink-2">
              <span>Project, searchable past eight options</span>
              <SearchableSelect label="Project" value={project} onValueChange={setProject} options={PROJECTS} />
            </div>
            <label className="flex flex-col gap-s1 t-small text-ink-2 sm:col-span-2">
              Instructions
              <Textarea defaultValue="Keep the digest under 1,500 words." />
            </label>
          </div>
          <SearchInput label="Search everything" hint="⌘K" />
          <Card padding="flush" className="divide-y divide-line">
            <div className="flex items-center justify-between gap-s4 px-s4 py-s3">
              <label htmlFor="switch-learning" className="flex flex-col">
                <span className="t-body text-ink">Learn from sessions</span>
                <span className="t-small text-muted">Myco reads ended sessions and saves what it learns as spores.</span>
              </label>
              <Switch id="switch-learning" checked={learning} onCheckedChange={setLearning} />
            </div>
            <div className="flex items-center justify-between gap-s4 px-s4 py-s3">
              <label htmlFor="switch-titling" className="flex flex-col">
                <span className="t-body text-ink">Title imported sessions</span>
                <span className="t-small text-muted">Imported history gets a title the next time Myco runs.</span>
              </label>
              <Switch id="switch-titling" checked={titling} onCheckedChange={setTitling} />
            </div>
          </Card>
        </Section>

        <Section id="filter" kicker="Patterns" title="The filter bar">
          <FilterBar
            searchLabel="Search sessions"
            query={query}
            onQueryChange={setQuery}
            filters={[{ key: 'agent', label: 'Agent', options: AGENTS }, { key: 'window', label: 'When', options: WINDOWS }]}
            values={filters}
            onFilterChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))}
            onClear={() => { setQuery(''); setFilters({ agent: 'all', window: 'all' }); }}
            count="34 sessions"
            hint="/"
          />
        </Section>

        <Section id="lists" kicker="Patterns" title="Rows, days and paging">
          <Card padding="flush" className="overflow-hidden">
            <DayGroup label="Today" count={2}>
              <ListRow
                to="/sessions/one"
                leading={<HealthDot tone="ok" live label="Live" />}
                title="Canopy parity verified against the hosted map"
                meta="myco · Claude Code · studio machine · 2 h 10 min"
                trailing={<StatusChip tone="ok">Live</StatusChip>}
              />
              <ListRow
                to="/sessions/two"
                leading={<HealthDot tone="faint" label="Ended" />}
                title="Split the search index retries from real failures"
                meta="myco · Codex · second machine · 38 min"
                trailing="4:12 PM"
                cursor
              />
            </DayGroup>
            <DayGroup label="Yesterday" count={1}>
              <ListRow
                to="/sessions/three"
                leading={<HealthDot tone="bad" label="Failed" />}
                title="Map run failed: the repository was unreachable"
                meta="docs site · Myco · learning"
                trailing={<StatusChip tone="bad">Failed</StatusChip>}
              />
            </DayGroup>
          </Card>
          <ShowMore shown={3} total={34} noun="sessions" onMore={() => undefined} />
        </Section>

        <Section id="tabs" kicker="Primitives" title="Tabs">
          <Tabs defaultValue="conversation">
            <TabsList aria-label="Session">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="spores" count={4}>Spores</TabsTrigger>
              <TabsTrigger value="plans" count={1}>Plans</TabsTrigger>
            </TabsList>
            <TabsContent value="conversation"><p className="t-body text-ink-2">The conversation, at 72 characters a line.</p></TabsContent>
            <TabsContent value="spores"><p className="t-body text-ink-2">Four spores came of this session.</p></TabsContent>
            <TabsContent value="plans"><p className="t-body text-ink-2">One plan.</p></TabsContent>
          </Tabs>
        </Section>

        <Section id="status" kicker="Primitives" title="Status, types and people">
          <div className="flex flex-wrap items-center gap-s3">
            <StatusChip tone="ok">Live</StatusChip>
            <StatusChip tone="warn">Queued</StatusChip>
            <StatusChip tone="bad">Failed</StatusChip>
            <StatusChip>held off</StatusChip>
            <TypeChip>Decision</TypeChip>
            <TypeChip>Gotcha</TypeChip>
            <TypeChip>Fix</TypeChip>
            <Kbd>⌘K</Kbd>
          </div>
          <div className="flex flex-wrap items-center gap-s6">
            <HealthDot tone="ok" live showLabel label="Claude Code · just now" />
            <HealthDot tone="warn" showLabel label="Codex · 4 h ago" />
            <HealthDot tone="bad" showLabel label="Cursor · 3 days ago" />
            <HealthDot tone="faint" showLabel label="OpenCode · never" />
          </div>
          <div className="flex items-center gap-s3">
            <Avatar name="Chris Kirby" size="sm" />
            <Avatar name="Chris Kirby" />
            <Avatar name="octocat" size="lg" />
          </div>
        </Section>

        <Section id="facts" kicker="Patterns" title="Numbers, facts and commands">
          <div className="grid gap-s3 sm:grid-cols-3">
            <Stat label="What it cost" value="$44.54" context="The agents' own estimate; 3 runs reported none." />
            <Stat label="Learned" value="7 spores" context="from 4 sessions today" tone="ok" trend={{ data: [2, 4, 1, 0, 3, 5, 7], label: 'Spores learned each day this week' }} />
            <Stat label="Last backup" value="28 days" context="Backups run weekly." tone="warn" />
          </div>
          <div className="grid gap-s4 lg:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-s4">
              <CommandBlock caption="On the machine you want to connect, run" command="myco login https://myco.example.test/join#k3y" />
              <Disclosure summary="Technical details">
                <p className="t-small text-muted">Queued at 4:12 PM, leased by the studio machine, finished in 38 seconds.</p>
              </Disclosure>
              <p className="t-body text-ink-2">
                A <Link to="/knowledge">link inside text</Link> reads in the primary colour, underlined.
              </p>
            </div>
            <FactsPanel title="Facts" actions={<CopyButton value="myco resume sess_example" label="Copy resume command" />}>
              <FactRow term="Agent">Claude Code</FactRow>
              <FactRow term="Machine">studio machine</FactRow>
              <FactRow term="Started">Sep 29, 9:41 AM</FactRow>
              <FactRow term="Branch" mono>feat/1518-p1a</FactRow>
            </FactsPanel>
          </div>
        </Section>

        <Section id="overlays" kicker="Primitives" title="Menus and dialogs">
          <div className="flex flex-wrap items-center gap-s3">
            <MoreMenu
              items={[
                { label: 'Retitle', onSelect: () => undefined },
                { label: 'Copy id', onSelect: () => undefined },
                { label: 'End session', onSelect: () => undefined, tone: 'danger' },
                { label: 'Delete session', onSelect: () => setConfirming(true), tone: 'danger' },
              ]}
            />
            <Dialog>
              <DialogTrigger asChild><Button>Open a dialog</Button></DialogTrigger>
              <DialogContent title="Rename project" description="The name shows everywhere the project does.">
                <Input aria-label="Project name" defaultValue="myco" />
                <DialogFooter>
                  <Button variant="primary">Rename</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button variant="danger" onClick={() => setConfirming(true)}>Confirm a deletion</Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title="Delete this session?"
              description="Its 18 prompts, 4 spores and 1 plan are removed from every project view. This cannot be undone."
              confirmLabel="Delete session"
              onConfirm={() => setConfirming(false)}
            />
          </div>
        </Section>

        <Section id="states" kicker="Patterns" title="Empty, failed and loading">
          <EmptyState title="Nothing today" action={<Link to="/?day=yesterday">Yesterday's work →</Link>} />
          <div className="grid gap-s4 sm:grid-cols-2">
            <ErrorState error={new ApiError(404, null)} back={{ to: '/', label: 'Back to Today' }} />
            <ErrorState error={new TypeError('Failed to fetch')} onRetry={() => undefined} />
          </div>
          <Card padding="flush"><LoadingState label="Loading sessions" count={3} /></Card>
        </Section>
      </main>
    </div>
  );
}
