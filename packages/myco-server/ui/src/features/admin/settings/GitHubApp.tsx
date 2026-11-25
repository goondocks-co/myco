import { useState } from 'react';
import {
  appSettingsLocation, GITHUB_APPS_LISTS, githubAppChecklist, githubAppHeadline, githubAppPages, ownerWords, SETUP_WORDS, WITHHELD_WORDS,
  type GitHubAppSetup, type RepositorySuggestion, type SetupLink, type SetupStep, type StepState,
} from '@goondocks/myco-shared/github-app-setup';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, CommandBlock, Disclosure, ErrorState, ExternalLink, LoadingState, StatusChip, tapTarget, type Tone } from '../../../design';
import {
  settingsRefusalText, useConnectSuggestion, useGitHubAccountActions, useGitHubAppSetup, useGitHubInstallations, useRepositorySuggestions,
} from '../../../hooks/use-settings';
import { SETTINGS_SECTIONS } from '../../../routes/nav';
import { ConnectionRow } from './ConnectionRow';

const STATE: Record<StepState, { label: string; tone: Tone }> = {
  done: { label: 'Done', tone: 'ok' },
  todo: { label: 'To do', tone: 'warn' },
  failed: { label: 'Needs attention', tone: 'bad' },
  waiting: { label: 'Waiting', tone: 'neutral' },
};

/** Where a link to the GitHub App setup lands, on Repositories. */
export const GITHUB_ANCHOR = 'github-app';
const REPOSITORIES_PATH = SETTINGS_SECTIONS.find((section) => section.id === 'repositories')!.to;

/** Whether the App is set up and reading, as a chip. */
export function githubStatus(setup: GitHubAppSetup | undefined): { words: string; tone: Tone } {
  if (setup === undefined) return { words: 'Checking', tone: 'neutral' };
  const steps = githubAppChecklist(setup, window.location.origin);
  if (steps.every((step) => step.state === 'done')) return { words: 'Working', tone: 'ok' };
  return steps.some((step) => step.state === 'failed') ? { words: 'Needs attention', tone: 'bad' } : { words: 'Not set up', tone: 'warn' };
}

/** The App's setup, read live, and whether it works; Test reads both again. */
function useGitHubCheck() {
  const setup = useGitHubAppSetup();
  const data = setup.data;
  const keyWorks = data?.key.state === 'ready' || data?.key.state === 'permissions_missing';
  const installations = useGitHubInstallations(keyWorks);
  const check = () => { void setup.refetch(); if (keyWorks) void installations.refetch(); };
  const status = setup.isError ? { words: 'Could not check', tone: 'bad' as const } : githubStatus(data);
  return { setup, installations, keyWorks, check, status };
}

/** GitHub on Connections: what it is for and whether it works, Test, and the way to Repositories, where it is set up. */
export function GitHubRow() {
  const { setup, check, status } = useGitHubCheck();
  return (
    <ConnectionRow
      kind="github"
      label="GitHub"
      use="Sign-in, and reading your repositories."
      status={status}
      note={setup.dataUpdatedAt > 0 ? <p>{`Checked ${agoWords(setup.dataUpdatedAt, Date.now())}`}</p> : undefined}
      actions={<>
        <Button size="sm" onClick={check} pending={setup.isFetching}>Test</Button>
        <ActionLink to={`${REPOSITORIES_PATH}#${GITHUB_ANCHOR}`}>Repositories</ActionLink>
      </>}
    />
  );
}

/** The accounts the App is installed on, ignoring suspended ones. */
const installedOn = (setup: GitHubAppSetup): string[] => setup.installations !== null && 'list' in setup.installations
  ? setup.installations.list.filter((installation) => !installation.suspended).map((installation) => installation.account.login) : [];

const listWords = (items: readonly string[]): string => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;

/**
 * GitHub on Repositories: which App reads your repositories, who owns it, where it is installed and whether it works,
 * with Test and installing it on another account. The live setup checklist folds under it, open until every step is
 * done.
 */
export function GitHubReadRow() {
  const { setup, installations, check, status } = useGitHubCheck();
  const data = setup.data;
  const app = data?.app ?? null;
  const pages = app === null ? null : githubAppPages(app.slug, app.owner);
  const installed = data === undefined ? [] : installedOn(data);
  const done = status.words === 'Working';
  const steps = data === undefined ? [] : githubAppChecklist(data, window.location.origin);
  return (
    <>
      <ConnectionRow
        id={GITHUB_ANCHOR}
        kind="github"
        label="GitHub"
        use={app === null
          ? 'Myco reads your repositories, read-only, through this server’s own GitHub App.'
          : `Myco reads your repositories, read-only, through its own GitHub App: ${app.name}${app.owner === null ? '' : `, owned by ${ownerWords(app.owner)}`}.`}
        status={status}
        note={<>
          {installed.length > 0 && <p data-installed-on="">{`Installed on ${listWords(installed)}${app?.owner == null ? '' : `. ${appSettingsLocation(app.owner)}`}`}</p>}
          {data !== undefined && !done && <p data-setup-headline="">{githubAppHeadline(steps, data)}</p>}
          {setup.dataUpdatedAt > 0 && <p>{`Checked ${agoWords(setup.dataUpdatedAt, Date.now())}`}</p>}
        </>}
        actions={<Button size="sm" onClick={check} pending={setup.isFetching}>Test</Button>}
      >
        {setup.isPending ? <LoadingState label="Checking the GitHub App with GitHub" count={2} />
          : setup.isError ? <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
          : <Disclosure summary={done ? 'Setup and approved accounts' : 'Finish setting up'} defaultOpen={!done}>
            <GitHubSetup setup={setup.data} installations={installations} />
          </Disclosure>}
      </ConnectionRow>
      {pages !== null && (
        <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
          <p className="max-w-measure t-small text-muted">To read another account’s repositories, install the App there too. Signing in with GitHub does not install it.</p>
          <ExternalLink href={pages.install} className={`shrink-0 t-small ${tapTarget}`}>Install on another account</ExternalLink>
        </div>
      )}
    </>
  );
}

/** The App's identity, its live checklist and the accounts approved here. */
export function GitHubSetup({ setup, installations }: { setup: GitHubAppSetup; installations: ReturnType<typeof useGitHubInstallations> }) {
  const accounts = useGitHubAccountActions();
  return (
    <div className="flex flex-col gap-s4" data-github-app-setup="">
      <AppIdentity setup={setup} />
      <Checklist setup={setup} />
      {installations.isSuccess && installations.data.accounts.length > 0 && (
        <div className="flex flex-col gap-s2" data-approved-accounts="">
          <p className="t-small text-muted">Repositories can be connected from installations by these accounts:</p>
          {installations.data.accounts.map((account) => (
            <div key={account.accountId} className="flex flex-wrap items-center justify-between gap-s3">
              <span className="t-small">{ownerWords(account)}</span>
              <Button variant="ghost" pending={accounts.withdraw.isPending && accounts.withdraw.variables === account.accountId}
                onClick={() => accounts.withdraw.mutate(account.accountId)}>Remove approval</Button>
            </div>
          ))}
        </div>
      )}
      {installations.isError && <p role="alert" className="t-small text-bad">{settingsRefusalText(installations.error)}</p>}
    </div>
  );
}

/** Which App this is and who owns it, or where to look for it when GitHub has not said. */
function AppIdentity({ setup }: { setup: GitHubAppSetup }) {
  const app = setup.app;
  const pages = app === null ? null : githubAppPages(app.slug, app.owner);
  return <div className="flex flex-col gap-s2" data-app-identity="">
    {app === null ? <>
      <p className="t-body">{SETUP_WORDS.find(setup.expectedName, setup.clientId)}</p>
      <GitHubLinks links={[{ label: 'Your GitHub Apps', href: GITHUB_APPS_LISTS.personal }, { label: 'Your organizations', href: GITHUB_APPS_LISTS.organizations }]} />
      {setup.lookupError !== null && <p className="t-small text-muted">{`GitHub’s public page for the App did not answer: ${setup.lookupError}`}</p>}
    </> : <>
      <p className="t-body">{`This server’s App is ${app.name}${app.owner === null ? '' : `, owned by ${ownerWords(app.owner)}`}.`}</p>
      {app.owner !== null && <p className="t-small">{appSettingsLocation(app.owner)}</p>}
      <GitHubLinks links={[{ label: pages!.settings === null ? 'Open the App on GitHub' : 'Open the App’s settings', href: pages!.settings ?? pages!.app }]} />
    </>}
    <p className="t-small text-muted">{SETUP_WORDS.confirmAccess}</p>
  </div>;
}

function Checklist({ setup }: { setup: GitHubAppSetup }) {
  const steps = githubAppChecklist(setup, window.location.origin);
  return <div className="flex flex-col gap-s3">
    <ol className="flex flex-col divide-y divide-line" aria-label="Repository access setup">
      {steps.map((step) => <li key={step.id} className="flex flex-col gap-s2 py-s3" data-step={step.id} data-state={step.state}>
        <div className="flex flex-wrap items-start gap-s2">
          <StatusChip tone={STATE[step.state].tone}>{STATE[step.state].label}</StatusChip>
          <span className="min-w-0 flex-1 t-body">{step.title}</span>
        </div>
        <StepBody step={step} />
        {step.id === 'approved' && <Unapproved setup={setup} />}
      </li>)}
    </ol>
  </div>;
}

/** Links to GitHub, each its own line and a fingertip tall. */
function GitHubLinks({ links }: { links: SetupLink[] }) {
  return <div className="flex flex-col items-start t-small">
    {links.map((link) => <ExternalLink key={link.href} href={link.href} className={tapTarget}>{link.label}</ExternalLink>)}
  </div>;
}

function StepBody({ step }: { step: SetupStep }) {
  return <>
    {step.detail.map((line) => <p key={line} className="t-small text-muted">{line}</p>)}
    {step.commands.map((command) => <CommandBlock key={command} command={command} />)}
    {step.links.length > 0 && <GitHubLinks links={step.links} />}
  </>;
}

/** Installations by accounts this server has not approved, each approved here with one press. */
function Unapproved({ setup }: { setup: GitHubAppSetup }) {
  const accounts = useGitHubAccountActions();
  const waiting = setup.installations !== null && 'list' in setup.installations
    ? setup.installations.list.filter((installation) => !installation.approved && !installation.suspended) : [];
  if (waiting.length === 0 && !accounts.approve.error) return null;
  return <div className="flex flex-col gap-s2">
    {waiting.map((installation) => <div key={installation.installationId} className="flex flex-wrap items-center justify-between gap-s3" data-installation={installation.installationId}>
      <span className="t-small">{`Installed by an account this server has not approved: ${ownerWords(installation.account)}${installation.permissionsAccepted ? '' : '; has not accepted the new permissions'}`}</span>
      <Button pending={accounts.approve.isPending && accounts.approve.variables === installation.installationId}
        onClick={() => accounts.approve.mutate(installation.installationId)}>Approve</Button>
    </div>)}
    {accounts.approve.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(accounts.approve.error)}</p>}
  </div>;
}

/** Proposes, for each Project with no repository, the one repository of the same name; each is connected only when confirmed. */
export function ProjectRepositories() {
  const proposals = useRepositorySuggestions();
  const connect = useConnectSuggestion();
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const save = async (proposal: RepositorySuggestion) => {
    try { await connect.mutateAsync(proposal); setOutcome((was) => ({ ...was, [proposal.projectId]: 'Connected.' })); }
    catch (error) { setOutcome((was) => ({ ...was, [proposal.projectId]: settingsRefusalText(error) })); }
  };
  const open = (proposals.data?.suggestions ?? []).filter((proposal) => outcome[proposal.projectId] !== 'Connected.');
  const connectAll = async () => { for (const proposal of open) await save(proposal); };
  return <div className="flex flex-col gap-s2" data-project-repositories="">
    <p className="t-small text-muted">Myco can propose, for each Project with no repository, the one repository of the same name in the approved accounts’ installations. Nothing is connected until you confirm it.</p>
    <div><Button variant="ghost" pending={proposals.isFetching} onClick={() => void proposals.refetch()}>Find repositories for my Projects</Button></div>
    {proposals.isError && <p role="alert" className="t-small text-bad">{settingsRefusalText(proposals.error)}</p>}
    {proposals.isSuccess && (proposals.data.suggestions.length === 0
      ? <p className="t-small text-muted">No Project without a repository has exactly one repository of the same name in the approved accounts’ installations. Connect one from the Project’s Settings → Repository.</p>
      : <ul className="flex flex-col gap-s2" aria-label="Proposed repositories">
        {proposals.data.suggestions.map((proposal) => <li key={proposal.projectId} className="flex flex-wrap items-center justify-between gap-s3" data-proposal={proposal.projectId}>
          <span className="min-w-0 t-small">{`${proposal.project}: ${proposal.fullName}, branch ${proposal.defaultBranch}`}</span>
          {outcome[proposal.projectId] === 'Connected.' ? <span className="t-small text-ok">Connected.</span>
            : <Button pending={connect.isPending && connect.variables?.projectId === proposal.projectId} onClick={() => void save(proposal)}>Connect</Button>}
          {outcome[proposal.projectId] !== undefined && outcome[proposal.projectId] !== 'Connected.' && <p role="alert" className="w-full t-small text-bad">{outcome[proposal.projectId]}</p>}
        </li>)}
      </ul>)}
    {open.length > 1 && <div><Button variant="primary" disabled={connect.isPending} onClick={() => void connectAll()}>{`Connect all ${open.length}`}</Button></div>}
    {proposals.data?.complete === false && <p className="t-small text-muted">Some accounts hold more repositories than were searched, so no repository is proposed: another of the same name could be among those not searched.</p>}
    {(proposals.data?.withheld.length ?? 0) > 0 && <ul className="flex flex-col gap-s2" aria-label="Projects to connect by hand">
      {proposals.data!.withheld.map((project) => <li key={project.projectId} className="t-small" data-withheld={project.projectId}>{`${project.project}: ${WITHHELD_WORDS}`}</li>)}
    </ul>}
  </div>;
}
