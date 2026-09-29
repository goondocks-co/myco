# Upgrading from Myco 1.4

Myco 2.0 keeps your team's knowledge on a Deployment instead of in a vault on each laptop. Moving a machine over is one command, and it brings everything with it: every session, prompt, spore and plan your 1.4 vaults hold, and the agent transcripts still on disk. Your 1.4 vaults are copied, never changed or deleted.

## Before you start

You need a Deployment to move to, and an invite link for it. If your team already runs one, ask its administrator for a link. If you are the first, set one up with [Self-hosting](self-hosting.md) and invite yourself.

## Move a machine

```bash
curl -fsSL https://myco.sh/install.sh | sh
myco login <invite link>
myco cutover --dry-run
myco cutover
```

The installer notices Myco 1.4 and says so. It puts the 2.0 binary in place and moves nothing; 1.4's hooks stop capturing from that moment until you finish, so run the rest straight away.

`myco login` signs this machine in to your Deployment.

`myco cutover --dry-run` reads everything and changes nothing. It prints every change the real run would make, in order, and stops without changing anything if something on the machine belongs to another installation. Read it before you go on.

`myco cutover` then:

- backs up every agent settings file it is about to change;
- connects every project folder your 1.4 vaults name to that project on the Deployment;
- points your agents at 2.0, and takes 1.4 out of every agent it had registered with, including agents 2.0 does not capture (it says which);
- stops the 1.4 service and removes it, so it does not come back at the next login;
- copies each 1.4 vault, checks the copy, and brings its history to the Deployment, with your 1.4 session titles;
- brings in the agent transcripts still on disk.

It is safe to run again. A second run finishes whatever the first left, and imports nothing twice.

## What it keeps, and how to undo it

Nothing 1.4 wrote is deleted. Your vaults stay in `~/.myco/groves`, and the copies the import read from sit beside them in `~/.myco/backups`.

Every settings file, service file and link the cutover changed is copied first into one folder, `~/.myco/backups/cutover-<date>/`, never beside the file itself, so your project folders gain nothing. Beside the copies are two files:

- `manifest.json` lists every file, entry and link the cutover changed, with a checksum of each copy.
- `restore.md` holds the commands that put each one back, in the right order.

To go back to 1.4 by hand, run the commands in `restore.md`, then start the 1.4 service again from its restored file. Your Deployment keeps what was imported.

## Several machines, or several homes

Run the same steps on every machine that ran 1.4. Each machine imports the sessions it captured; a vault shared between machines leaves the other machines' sessions for them, and the report names which machine should run the import.

If 1.4 lived in more than one home on a machine, name each one:

```bash
myco cutover --legacy-home ~/.myco --legacy-home ~/.myco-dev --dry-run
```

Transcripts recorded in folders that no longer exist, such as removed worktrees, can be pointed at the project they belong to with `--map`:

```bash
myco cutover --map /Users/you/Repos/app-*=/Users/you/Repos/app
```

## When the dry run stops

The dry run refuses, and names what it found, when something it would change belongs to another installation: a hook or MCP entry of another Myco home, a machine pin naming a different home, or a Myco 1.4 service that starts at boot. See [Troubleshooting](troubleshooting.md#the-cutover-stops-before-it-starts) for each message and what to do.
