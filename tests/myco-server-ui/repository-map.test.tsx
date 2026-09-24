import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderMap } from '@goondocks/myco-shared/canopy';
import { RepositoryMapPanel } from '../../packages/myco-server/ui/src/pages/ProjectHome';
import { MEMORY_TASKS } from '../../packages/myco-server/ui/src/hooks/use-intelligence';

afterEach(() => { cleanup(); });

const repository = { url: 'https://example.test/team/source', branch: 'main', commit: 'a1b2c3d4e5f6'.padEnd(40, '0') };
const evidence = [{ path: 'src/main.ts', sha256: 'c'.repeat(64) }];
const content = renderMap({
  directories: [{ path: 'src', annotation: 'The application source.', groundedIn: evidence }],
  domains: [{ id: 'startup', title: 'Startup', files: [{ path: 'src/main.ts', annotation: 'Starts the application.', groundedIn: evidence }] }],
}, repository);

const mount = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('the code map on the project home', () => {
  it('shows the map read from one commit, links the run that wrote it, and keeps the provenance block out of the page', () => {
    mount(<RepositoryMapPanel base="/p/proj_1" pending={false} error={null}
      map={{ revision: 'rev_1', content, repository, sourceRunId: 'run_map', generatedAt: Date.now() - 60_000 }} />);
    const panel = screen.getByTestId('repository-map');
    expect(panel.textContent).toContain('Where things live');
    expect(panel.textContent).toContain('main @ a1b2c3d4');
    expect(panel.textContent).toContain('Starts the application.');
    expect(panel.textContent).toContain('Startup');
    expect(panel.textContent).not.toContain('Map Provenance');
    expect(screen.getByRole('link', { name: /The run that wrote it/ }).getAttribute('href')).toBe('/p/proj_1/runs/run_map');
  });

  it('says how a map appears when the project has none, and names the task that writes one', () => {
    mount(<RepositoryMapPanel base="/p/proj_1" pending={false} error={null} map={null} />);
    const panel = screen.getByTestId('repository-map');
    expect(panel.textContent).toContain('No map yet');
    const task = MEMORY_TASKS.find((entry) => entry.id === 'canopy-map');
    expect(task).toBeDefined();
    expect(panel.textContent).toContain(task!.label);
  });

  it('says the read failed rather than showing an empty map', () => {
    mount(<RepositoryMapPanel base="/p/proj_1" pending={false} error={new Error('boom')} map={null} />);
    expect(screen.getByTestId('repository-map').textContent).toContain('Could not load the code map.');
  });
});
