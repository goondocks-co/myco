# Running your own Myco server

Myco's server is one file. It holds your team's sessions, spores and plans, answers your coding agents over MCP, and schedules the work that turns transcripts into knowledge. You can run it on the laptop you already code on, or on a small virtual machine your team shares.

It needs no container runtime, no Node.js, and no source checkout. The `myco` binary you already installed is the server.

There is one exception, and it is on your own computer rather than the server: putting a server on Cloudflare uses Cloudflare's own command-line tool, which needs Node.js. Nothing is installed on the server itself.

## On your laptop

```bash
myco server create --target local
myco server github-app --target local --url http://127.0.0.1:8787 --name "Myco sign-in"
myco server setup-owner --target local
myco server install --target local
```

The first command prepares your server and generates its storage keys. The second opens GitHub to register an identity-only sign-in app under your account. Confirm the app there, then return to the terminal. `setup-owner` prints a private link for connecting your GitHub account to the first administrator. The last command starts the server and makes it come back whenever you log in.

Open the private link printed by `setup-owner`. Sign in with GitHub, check the account shown, and click **Connect this account**, then **Open Projects**. The link expires after 15 minutes. Keep it private: whoever uses it can become this server's administrator.

To capture from this laptop too, open **People & machines**, choose **Add a machine** with **For** set to yourself, and run the `myco login` command it shows. The server runs its own worker for Myco's work from its next start.

Owner setup requires a stopped server. If its link expires, stop the server, rerun `setup-owner`, and start it again; the replacement link invalidates the previous one. Once an account is connected, setup refuses. Existing or restored memberships use their existing sign-in and invitation flow; setup does not replace them.

Your server lives at `http://127.0.0.1:8787` and listens only on your own machine. Nothing outside your laptop can reach it until you choose to expose it.

`myco server status` tells you whether the service is set to run and whether the server is actually answering, which are different things: a server that starts and immediately fails still counts as installed.

```bash
myco server status --target local     # address, whether it is running, where its data lives
myco server run --target local        # run it in this terminal instead, to watch it work
```

Its data sits in `~/.myco/server/local/`, and its output goes to `~/.myco/logs/server.log` on every platform.

Pick a different port with `--port` if 8787 is taken. To stop it starting at login, run `myco server uninstall --target local`; your data is kept. `myco server destroy --target local --data --yes` removes the server and everything in it.

Both of those act on the service. A server you started yourself with `myco server run` keeps running in its own terminal until you stop it there.

### Changing the sign-in app

Stop a foreground server with Ctrl-C and wait for it to exit. For an installed service, run `myco server uninstall --target local`; this keeps your data. Run the `github-app` command again, then restart with `myco server run --target local` or `myco server install --target local`.

Setup refuses while the server is running. During registration, another server cannot start on the same data. Your storage and session keys stay unchanged when you replace the GitHub sign-in pair. If registration expires or GitHub refuses it, rerun the command. Keep the server stopped until setup finishes, then verify sign-in in the dashboard.

Use the server's configured public origin as `--url` when a reverse proxy fronts it. The app's callback must match the address the server uses.

## On a virtual machine

Anywhere that runs a Linux binary works. A machine with 1 GB of memory and a few gigabytes of disk is enough for a small team.

Copy the binary across, then provision it, configure sign-in and install its service as above. The server runs through your user's service manager, so nothing runs as root.

**Fly.io** is the least work if you would rather not manage a machine. Its builds happen remotely, so you never need a container runtime on your own computer, and a machine with a small volume attached costs a few dollars a month. Give the volume to `~/.myco/server/local/` and the server keeps its data across restarts.

**A plain VPS** works the same way. A basic droplet or equivalent is about the same price. Copy the binary, follow the setup commands above, and put a reverse proxy in front of it for HTTPS.

On Linux, a user service stops when you log out unless the machine is told to keep it running:

```bash
sudo loginctl enable-linger "$USER"
```

Without that, a server on a VM you connect to over SSH stops the moment you disconnect.

When something else terminates HTTPS in front of your server, tell it which header carries the caller's real address. `myco server status` shows the settings file to edit. The server refuses to start rather than trusting an address a caller could have written itself.

## On Cloudflare

Your server can also run on Cloudflare's free plan, where there is no machine to keep alive and no address to expose. Its storage, its files and its scheduled work all live on Cloudflare, and it costs nothing until your team is large.

You need three things on your own computer, and none of them on the server: the `myco` binary, Node.js, and the Cloudflare command-line tool signed in to your account.

```bash
npm install -g wrangler && wrangler login
```

Myco never installs the Cloudflare tool for you. Without it, or without a login, every command stops and prints these two commands.

Then three commands, the same three as on your laptop:

```bash
myco server create --target cloudflare --account-id <your account id>
myco server github-app --target cloudflare --url <the address create printed> --name "Myco sign-in"
myco server setup-owner --target cloudflare
```

`wrangler whoami` lists the accounts your login can reach, with their ids. Naming one is required rather than optional, so resources can never land in an account you did not mean.

`create` creates everything the server needs, brings its storage up to date, and puts it online. It ends by printing the other two commands with your server's address filled in. Re-running it is safe: it keeps what already exists and moves the rest forward, which also makes it the way to adopt pieces you created by hand. That includes a session key or storage key a stopped run never set: a re-run sets it, and never replaces one that is already there.

To see what `create` would do before it does anything, add `--dry-run`. It lists every resource and key it would create or keep, and everything the server will be connected to, and changes nothing in your account or on your computer.

Add `--url https://myco.example.com` to put the server on a domain you own, if the domain is already in the same Cloudflare account. Without it you get a `workers.dev` address, which works just as well for agents.

`github-app` registers the sign-in app, as on your laptop. `setup-owner` then prints a private link for connecting your GitHub account to the first administrator. It works over your Cloudflare login, from your own computer, while the server keeps running: there is nothing to stop and no database command to run. It refuses until sign-in works, and names the command that sets it up.

Open the link, sign in with GitHub and click **Connect this account**. The link expires after 15 minutes, and running `setup-owner` again replaces it. Once an account is connected, setup refuses, and **People & machines** is where you invite everyone else and add your own machines.

```bash
myco server status --target cloudflare      # the account, the address, and the version serving
myco server update --target cloudflare      # move it to the version this binary carries
myco server rollback --target cloudflare    # go back to the version that served before
```

Updating waits for nothing and interrupts nothing: a request already in progress finishes on the version that took it.

`myco server destroy --target cloudflare --yes` takes the server offline. Your data is kept — the database, the file storage and the stored keys all stay, and creating again brings the same server back.

## Reaching it from cloud agents

Agents that run on your own machine reach your server directly. Agents that run in someone else's cloud — Claude Code on the web, Codex cloud, a code review agent on a pull request — cannot see `127.0.0.1`, so your server needs a public address before they can read your context.

Two ways to give it one without moving it:

**Tailscale Funnel** gives your machine a stable `https://…ts.net` name on any plan. You will need MagicDNS and HTTPS certificates turned on for your network, and the machine needs permission to use Funnel. It listens on 443, 8443 or 10000 only.

**Cloudflare Tunnel** connects your machine to a hostname you control. The quick version that needs no account is meant for testing and does not support the streaming transport MCP uses, so use a named tunnel with your own domain for anything you rely on.

Either way your server stays where it is and keeps its data locally. Only the address changes.

## Keeping it current

Run the installer again to replace the binary. Then bring the server's storage up to date and restart it:

```bash
myco server update --target local
```

It stops the server, brings its storage up to date, and starts it again. Running an older server against newer storage is refused rather than half-applied, so an interrupted update leaves your data intact.

## Backing it up

The Deployment backs itself up. Set how often, and how many copies to keep, under **Settings** → **Backups**. **Health** → **Backups** shows how the last one went.

- **On your laptop or a VM**, each automatic backup is a complete, verified copy.
- **On Cloudflare**, an automatic backup is staged inside your Cloudflare account. It is not yet a copy you can restore from, and **Health** says so. For one you can restore from, take a backup yourself, as below.

To take a backup yourself, while the server keeps running:

```bash
myco server backup --to <dir> --target local
myco server backup --to <dir> --target cloudflare
```

It snapshots the database and every stored file into `<dir>`, and checks each file it copied. Running the same command again resumes a copy that was interrupted. Use a new directory for each backup you want to keep.

A backup holds your team's data but not the server's keys. Keep these four somewhere safe of their own, as `NAME=value` lines in one file: `SECRET_WRAP_KEY`, `SESSION_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. On a laptop they are in `~/.myco/server/local/secrets.env`. Without `SECRET_WRAP_KEY`, the keys stored on the Deployment cannot be read back.

To restore, start from a fresh Myco home, so nothing you are running is touched:

```bash
MYCO_HOME=<fresh home> myco server restore --target local --from <dir> --secrets-from <keys file> --yes
```

On Cloudflare the same command takes `--target cloudflare --account-id <your account id>`, and it creates a new Deployment beside the old one, at its own address. Each restore keeps the backup and the original as they were.

