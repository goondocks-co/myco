import { useState } from 'react';
import {
  GITHUB_APPS_LISTS, githubAppChecklist, githubAppHeadline, githubAppPages, ownerWords, SETUP_WORDS, WITHHELD_WORDS,
  type GitHubAppSetup, type RepositorySuggestion, type SetupStep, type StepState,
} from '@goondocks/myco-shared/github-app-setup';
import { Button, Card, CommandBlock, ErrorState, ExternalLink, LoadingState, StatusChip, type Tone } from '../../../design';
import {
  settingsRefusalText, useConnectSuggestion, useGitHubAccountActions, useGitHubAppSetup, useGitHubInstallations, useRepositorySuggestions,
} from '../../../hooks/use-settings';
import { AdminSection } from '../AdminFrame';

const STATE: Record<StepState, { label: string; tone: Tone }> = {
  done: { label: 'Done', tone: 'ok' },
  todo: { label: 'To do', tone: 'warn' },
  failed: { label: 'Needs attention', tone: 'bad' },
  waiting: { label: 'Waiting', tone: 'neutral' },
};

/**
 * The server's GitHub App, set up from here: a checklist whose every step is read live from GitHub and this server
 * when the section opens and on Check again, with direct links to the App's own pages and the one command that needs
 * the operator's machine.
 */
export function GitHubApp() {
  const setup = useGitHubAppSetup();
  const data = setup.data;
  const keyWorks = data?.key.state === 'ready' || data?.key.state === 'permissions_missing';
  const installations = useGitHubInstallations(keyWorks);
  const accounts = useGitHubAccountActions();
  const check = () => { void setup.refetch(); if (keyWorks) void installations.refetch(); };
  return <AdminSection id="github-app" title="GitHub App" description="This server’s App signs people in and reads the repositories each account selects in GitHub, for accounts approved here.">
    {setup.isPending ? <LoadingState label="Checking the GitHub App with GitHub" count={3} />
      : setup.isError ? <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
      : <Card className="flex flex-col gap-s4" data-github-app-setup="">
        <AppIdentity setup={setup.data} />
        <Checklist setup={setup.data} />
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
        <div><Button onClick={check} pending={setup.isFetching}>Check again</Button></div>
      </Card>}
  </AdminSection>;
}

/** Which App this is and who owns it, or where to look for it when GitHub has not said. */
function AppIdentity({ setup }: { setup: GitHubAppSetup }) {
  const app = setup.app;
  const pages = app === null ? null : githubAppPages(app.slug, app.owner);
  return <div className="flex flex-col gap-s2" data-app-identity="">
    {app === null ? <>
      <p className="t-body">{SETUP_WORDS.find(setup.expectedName, setup.clientId)}</p>
      <p className="flex flex-wrap gap-s4 t-small">
        <ExternalLink href={GITHUB_APPS_LISTS.personal}>Your GitHub Apps</ExternalLink>
        <ExternalLink href={GITHUB_APPS_LISTS.organizations}>Your organizations</ExternalLink>
      </p>
      {setup.lookupError !== null && <p className="t-small text-muted">{`GitHub’s public page for the App did not answer: ${setup.lookupError}`}</p>}
    </> : <>
      <p className="t-body">{`This server’s App is ${app.name}${app.owner === null ? '' : `, owned by ${ownerWords(app.owner)}`}.`}</p>
      <p className="flex flex-wrap gap-s4 t-small">
        <ExternalLink href={pages!.settings ?? pages!.app}>{pages!.settings === null ? 'Open the App on GitHub' : 'Open the App’s settings'}</ExternalLink>
      </p>
    </>}
    <p className="t-small text-muted">{SETUP_WORDS.confirmAccess}</p>
  </div>;
}

function Checklist({ setup }: { setup: GitHubAppSetup }) {
  const steps = githubAppChecklist(setup, window.location.origin);
  return <div className="flex flex-col gap-s3">
    <p role="status" className="t-body font-medium text-ink" data-setup-headline="">{githubAppHeadline(steps, setup)}</p>
    <ol className="flex flex-col divide-y divide-line" aria-label="Repository access setup">
      {steps.map((step) => <li key={step.id} className="flex flex-col gap-s2 py-s3" data-step={step.id} data-state={step.state}>
        <div className="flex flex-wrap items-start gap-s2">
          <StatusChip tone={STATE[step.state].tone}>{STATE[step.state].label}</StatusChip>
          <span className="min-w-0 flex-1 t-body">{step.title}</span>
        </div>
        <StepBody step={step} />
        {step.id === 'approved' && <Unapproved setup={setup} />}
        {step.id === 'connected' && step.state !== 'waiting' && <ProjectRepositories />}
      </li>)}
    </ol>
  </div>;
}

function StepBody({ step }: { step: SetupStep }) {
  return <>
    {step.detail.map((line) => <p key={line} className="t-small text-muted">{line}</p>)}
    {step.commands.map((command) => <CommandBlock key={command} command={command} />)}
    {step.links.length > 0 && <p className="flex flex-wrap gap-s4 t-small">
      {step.links.map((link) => <ExternalLink key={link.href} href={link.href}>{link.label}</ExternalLink>)}
    </p>}
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
function ProjectRepositories() {
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
