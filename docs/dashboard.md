# The dashboard

The dashboard is where your team sees what its agents did and what Myco learned from it. It runs on your server. Open it from a connected repository with:

```bash
myco open
```

You sign in with GitHub. Your GitHub account reaches the dashboard through your sign-in as a member. An administrator connects it from **Settings › People and machines**: they choose **Connect GitHub** on your row and send you the link it makes. Open that link while signed in to GitHub as yourself. For a brand-new server, the owner starts with `myco setup`; see [Run your own Myco](self-hosting.md) for guided creation and the manual owner commands.

## Get started

On **Today**, **Get started** shows the next action for your setup, with links or commands to continue. It checks what has actually happened; an imported session does not count as live capture. Administrators see server and runner progress as well as capture; members see their own machine and session steps.

The checklist also appears when **Projects** is empty. **Hide for now** dismisses it in this browser; **Show Get started** brings it back on the empty Projects page. It disappears when the checks are complete. If it cannot check progress, it says so and offers **Retry**.

## Your projects

Today, Sessions, Knowledge and Myco's work each show one project, or every project at once. Switch with the project picker. Administrators can also open **Projects** for the full list and session counts.

### Today

**Today** shows what happened today: the sessions your agents captured, and what Myco made of them, in a timeline. Earlier days are a click away.

Beside the timeline, **Capture** shows which agents have sent sessions lately, and from which machines. An administrator also sees **Needs you**: anything on the server that is waiting for an administrator.

### Sessions

**Sessions** lists every captured session, newest first, with its title and summary. Search it by title, first prompt, agent or branch, or narrow it to one agent or one person.

A session's page has the conversation turn by turn, with the tool calls inside each turn. It ends with **what came of it**: the spores Myco learned from the session, and each run of Myco's work that read it. Its **Outcomes** tab lists the commits the session started and ended on, and each pull request, issue, tag, release or deploy its agent reported creating, linked when it is on GitHub. Its **Lineage** tab shows the sessions that started it and the ones it started, on one timeline.

### Knowledge

**Knowledge** is what the project knows, in three parts:

- **Spores.** The decisions, gotchas, discoveries, trade-offs and fixes Myco has learned, newest first. Narrow them by kind or by project. Each spore has its own page, with where it came from and what it replaced.
- **Plans.** The plans your agents wrote, on a board by status: in progress, open, done and abandoned. Each plan links to the session that wrote it.
- **Code map.** The project's map of where things live in its code. Select one project to read its map.

### Myco's work

**Myco's work** opens on what Myco is doing now:

- **Running now:** each task running, the machine and model running it, how long it has run, and what it did last.
- **Waiting:** work that is queued or due, and why it waits. For example, no runner can sign in, the daily curation limit is spent, or the code map is not due yet.
- **Needs you:** work that keeps failing, in Myco's own words, with a link to the run. An item goes away by itself once a later run succeeds.

Below that, Myco's work shows what Myco's own work came to: what it learned, the sessions it titled, the code map updates and what it learned from the code. Open any run to see what it read, what it produced, and who started it.

Open pages keep themselves up to date while they are in view, and update sooner while something is running. A page in a background tab stops checking until you come back to it. With many projects, Myco's work across every project checks the ones with something running, waiting or failing first and says when it did not check them all.

**Run a task** starts work now instead of waiting for the schedule:

- **Learn from new sessions now**
- **Update the code map now**
- **Learn from the project's code**

Every member can run a task in a project. A member who is not an administrator can start each task four times in a rolling day, across every project, and the dashboard says when they can start it again. An administrator has no daily limit. Work you start waits for a registered runner, like the rest of Myco's work. See [How Myco learns](how-myco-learns.md).

### Project settings

An administrator sets what Myco does in each project under **Project settings**:

- **What Myco does here.** Its switches are **Learning**, **Code map** and **Context for sessions**. They are described in [Configuration](configuration.md).
- **Repository.** The repository Myco reads to build the code map and learn from the code.
- **Access keys.** Keys for agents that are not members, such as a hosted code reviewer. See [External agents](external-agents.md).
- **Release tracking.** Which refs count as merged and released.

## Your machines

**Settings › People and machines** lists your machines, for every member, and an administrator sees every machine there, including runners nobody signed in on. **Manage** opens a machine's own page. It leads with what the machine is doing (Working while a runner on it holds a run, Capturing, Online while a runner waits for work, Quiet since a day, Offline or Removed), whose it is and since when, then answers:

- **Does it do Myco's work?** One card for each runner registered on the machine, each with its own controls: turn it on or off, the agent the server would use for learning from sessions and who pays, whether other runners with that agent pay the same way, setting this runner apart, its other signed-in agents as it last reported them, its recent runs, and removing it as a runner. A machine runs as a runner when its registration was approved for it, whatever its later check-ins report. A legacy worker on the machine is shown with the way to move it to a runner. Otherwise, the one command that makes it a runner.
- **What does it capture?** The agents set up on it, the folders whose repositories it captures by themselves (**Change folders** holds **Folders it captures**, **Extra plan folders** and the rest of its folder settings), repositories waiting outside them with **Connect**, when it last captured, and **What it sent**.
- **How does it stay current?** Its update preferences, and for a runner the release it reported with **Update now**.
- **Stop it capturing** ends its sign-ins, so it sends nothing more; a runner on it keeps taking work until it is removed in its own card. What it sent is kept. The ⋯ menu beside its name renames it.

A machine is described only by what the server recorded. A runner reports its operating system, CPU type and version; a machine that only captures reports none of these, so its page leaves them out.

### Machine names

A machine is named for its host name when it signs in. You see your own work as **on** the machine's name, or **on your machine**. Other members see it as **from** you, never your machine. Administrators can inspect other members' machine names on **Settings › People and machines**. On Today, Sessions and Myco's work, even an administrator sees another member's work as **from** that member.

## For administrators

The server pages sit at the foot of the menu. Every member can open **Settings › People and machines**; managing people and opening the other server pages require an administrator. The addresses `/people` and `/me/machines` lead there.

### Projects

**Projects** lists every project with its session count, when it last sent a session, and its archive state. Open a project to see its work, or use its project settings to change what Myco does there.

### People and machines

**Settings › People and machines** lists the server's members, the invitations still open, every machine, and the sign-ins Myco's own runs used. A person's **Manage** holds what you may do to them:

- **Invite a teammate** makes a one-time link for someone new. It is good for an hour or a day, and it shows the exact `myco login` command to send.
- **Add a machine** makes the same kind of link for a member who is already here. Use it for a second machine of theirs, or one whose sign-in ended.
- **Connect GitHub** links a member's GitHub account so they can open the dashboard.
- **Remove** ends a member's access. Their history stays, and their machines stay theirs.

> **Coming in beta.1:** inviting a teammate from the command line, for an owner whose GitHub sign-in is not set up yet ([#1551](https://github.com/goondocks-co/myco/issues/1551)). Until then, invitations are made here.

### Runners

**Runners** shows the machines explicitly registered to run Myco's work, their latest contact and the agents they offer. Registering a runner is separate from signing a member machine in. **Add runner** gives registration instructions. An administrator approves the device link and can later stop access from this page.

### Settings

**Settings** holds everything that applies to the whole server, in six sections:

- Myco's work
- People and machines
- Repositories
- Models
- Connections
- Advanced

[Configuration](configuration.md) walks through each one.

### Health

**Health** answers two questions about the server itself:

- **Is the server well?** One answer, **Yes**, **Needs attention** or **No**, with a sentence saying why, over five lines: **Sessions arriving** (when capture was last received, from whom and for which project; quiet after a day without any), **Learning from them** (when learning last completed, what waits, and whether it is moving, held or failing), **Somewhere to run** (runners that can do Myco's work now, of how many, and runs held for a reason you can change), **Within budget** (what counts against the daily budget now, or Not applied) and **Database and storage** (answering, at the expected version, with its storage set up; it also reflects a store check that found a problem and a failed or overdue automatic backup). Each line takes the worst of its facts, including failures Myco is still retrying. The answer is **No** when any line is No, **Needs attention** when any line needs attention, is unknown or could not be read, and **Yes** only when every line is Yes.
- **What needs you:** each thing waiting for an administrator, with a way to finish it and, where Myco has one, a way to decline it: dismiss it, never ask again, or turn the capability off for that project. A store check that found a problem, a stored key that was rejected and a failed automatic backup appear here too.

**Download diagnostics** at the foot of Health writes one file describing the server, with no keys and no captured content, to attach to an issue.

Backups (make, download, pin and restore them, and automatic backups) are in **Settings › Advanced › Backups**. Each hosted backup pauses database requests during its database export; the dashboard and tools cannot read or save data, and member capture waits for later delivery. Larger databases take longer. Housekeeping, search upkeep and the store checks, each with a way to run it now, are in **Settings › Advanced › Upkeep**. Figures such as how often agents call Myco per prompt, each with the sample behind it, are on **Is Myco helping?**, linked from Knowledge.

On a hosted Deployment, deleting a session removes it from Myco now, while its stored data is kept for at least 30 days before removal. The confirmation says so before deletion. Native session deletion keeps its existing storage lifetime.
