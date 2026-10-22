# The dashboard

The dashboard is where your team sees what its agents did and what Myco learned from it. It runs on your server. Open it from a connected repository with:

```bash
myco open
```

You sign in with GitHub. Your GitHub account reaches the dashboard through your sign-in as a member. An administrator connects it from **People & machines**: they choose **Connect GitHub** on your row and send you the link it makes. Open that link while signed in to GitHub as yourself. For a brand-new server, the owner starts with `myco setup`; see [Run your own Myco](self-hosting.md) for guided creation and the manual owner commands.

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

A session's page has the conversation turn by turn, with the tool calls inside each turn. It ends with **what came of it**: the spores Myco learned from the session, and each run of Myco's work that read it. Its **Lineage** tab shows the sessions that started it and the ones it started, on one timeline.

### Knowledge

**Knowledge** is what the project knows, in three parts:

- **Spores.** The decisions, gotchas, discoveries, trade-offs and fixes Myco has learned, newest first. Narrow them by kind or by project. Each spore has its own page, with where it came from and what it replaced.
- **Plans.** The plans your agents wrote, on a board by status: in progress, open, done and abandoned. Each plan links to the session that wrote it.
- **Code map.** The project's map of where things live in its code. Select one project to read its map.

### Myco's work

**Myco's work** shows what Myco's own work came to: what it learned, the sessions it titled, the code map updates and what it learned from the code. Open any run to see what it read, what it produced, and who started it.

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

**My machines** is in the account menu, for every member. It lists each of your machines with the agents that captured on it lately. From there you can:

- choose **Folders it captures** and **Extra plan folders** through **Its settings**;
- see what the machine wrote;
- stop it, which ends its sign-in.

### Machine names

A machine is named for its host name when it signs in. You see your own work as **on** the machine's name, or **on your machine**. Other members see it as **from** you, never your machine. Administrators can inspect other members' machine names on **People & machines** and **Health**. On Today, Sessions and Myco's work, even an administrator sees another member's work as **from** that member.

## For administrators

The server pages sit at the foot of the menu. **People & machines** is readable by every member; managing people and opening the other server pages require an administrator.

### Projects

**Projects** lists the projects, their session counts and archive state. Open a project to see its work, or use its project settings to change what Myco does there.

### People & machines

**People & machines** lists the server's members, each with their machines and the invitations still open.

- **Invite a teammate** makes a one-time link for someone new. It is good for an hour or a day, and it shows the exact `myco login` command to send.
- **Add a machine** makes the same kind of link for a member who is already here. Use it for a second machine of theirs, or one whose sign-in ended.
- **Connect GitHub** links a member's GitHub account so they can open the dashboard.
- **Remove** ends a member's access. Their history stays, and their machines stay theirs.

> **Coming in beta.1:** inviting a teammate from the command line, for an owner whose GitHub sign-in is not set up yet ([#1551](https://github.com/goondocks-co/myco/issues/1551)). Until then, invitations are made here.

### Runners

**Runners** shows the machines explicitly registered to run Myco's work, their latest contact and the agents they offer. Registering a runner is separate from signing a member machine in. **Add runner** gives registration instructions. An administrator approves the device link and can later stop access from this page.

### Settings

**Settings** holds everything that applies to the whole server, in five sections:

- Myco's work
- Models and keys
- Capture and retention
- Backups
- Sign-in and access

[Configuration](configuration.md) walks through each one.

### Health

**Health** is one page about the server itself:

- **Needs you:** what is waiting for an administrator.
- **Status:** whether the server is set up to hold your team's knowledge, and what each project last sent.
- **Workers:** the execution status machines last reported. Use **Runners** to manage runner registrations.
- **Backups:** the backups it holds, and how its automatic backups are doing.
- **Upkeep:** the housekeeping, search upkeep and store checks it does on its own, with a way to run each now.
- **Measures:** figures such as how often agents call Myco per prompt, each with the sample behind it.
