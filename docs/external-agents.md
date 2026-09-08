# External agents

Some agents that work on your project are not members of it. A hosted code
reviewer runs on someone else's infrastructure, has no Myco session, and never
signs in as a person. It still benefits from your project's knowledge, and what
it learns is worth keeping.

An **access key** gives one such agent read access to one project, plus the
ability to record what it found. Its writes are attributed to the key itself —
never to a person — so you can always see which findings came from the reviewer
and retire them as a group.

## What an external agent can do

| It can | It cannot |
|---|---|
| Search the project and read sessions, plans, skills and spores | Reach any other project, whatever it asks for |
| Record a new spore | Write or delete a plan |
| Mark one of its spores replaced by another | Retire or merge anyone else's knowledge |
| | See who wrote anything it reads |

The key reads and writes one project. Naming a different one is answered as
though the tool does not exist, so a misconfigured agent learns nothing about
what else you have.

## Issue a key

In the dashboard, open the project and add an access key under its access
settings. Give it a label you will recognise later, such as the name of the
service that will hold it.

**The key is shown once.** Copy it straight into the other service's secret
store. Myco keeps only a fingerprint and cannot show it to you again — if you
lose it, rotate the key rather than hunting for it.

Every key expires. Ninety days is the default; you can ask for anything from one
day to a year. Rotating a key issues a replacement, ends the old one the same
instant, and gives the replacement the same length of life over again.

## Connect GitHub Copilot code review

Copilot reads its MCP configuration from your repository settings, not from a
file in the repository. Add Myco as a remote HTTP server and pass the key as a
header. Copilot supplies secrets whose names begin with `COPILOT_MCP_`, so store
the key under a name like `COPILOT_MCP_MYCO_KEY`.

```json
{
  "mcpServers": {
    "myco": {
      "type": "http",
      "url": "https://your-deployment.example.com/mcp",
      "headers": { "Authorization": "Bearer $COPILOT_MCP_MYCO_KEY" },
      "tools": ["*"]
    }
  }
}
```

Copilot reads `AGENTS.md` from the head branch of the pull request it is
reviewing, so the instructions telling it to use Myco belong in that file, on the
branch. The line in this repository's own `AGENTS.md` is the working example.

## Citing what produced a finding

An external agent has no Myco session to attach a finding to, so it cites the
work instead: the pull request it reviewed, or the commit it read. Ask it to pass
`provenance_kind` and `provenance_ref` when it records a spore — `"pr"` with the
pull request URL, or `"commit"` with the commit sha. Both are given together, or
neither.

That citation is what lets you trace a finding back to the change that prompted
it, months later, when the finding is all that survives.

## When something stops working

An agent whose key has expired, or whose key you rotated or revoked, is refused
outright. It is not told which of those happened; your project's activity log is.
Issue a new key and update the other service's secret.

Nothing an expired key wrote is lost. The spores it recorded keep their
attribution, and the key's record stays so that attribution still points
somewhere.
