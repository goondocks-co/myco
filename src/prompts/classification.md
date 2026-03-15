You are classifying files from coding session "{{sessionId}}" to determine which are substantive **project** artifacts worth preserving in a knowledge vault.

## Candidate Files

{{fileList}}

## Task

For each file that is a substantive project artifact (design doc, specification, implementation plan, RFC, or project documentation), classify it.

**DO NOT classify these — they are tooling, not project artifacts:**
- Agent/LLM instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, rules files)
- Plugin components: slash commands, skills, hooks, plugin manifests
- Configuration files, dotfiles, settings
- Implementation code, test files, generated output
- Prompt templates used by the tool/plugin itself
- README files that describe tool usage rather than project architecture

**DO classify these — they are project artifacts:**
- Design specifications and architecture documents
- Implementation plans and roadmaps
- RFCs and proposals
- Project documentation that captures decisions, context, or knowledge

Artifact types:
{{artifactTypes}}

Respond with valid JSON only, no markdown fences:
{
  "artifacts": [
    {
      "source_path": "exact/path/from/above",
      "artifact_type": "{{validTypes}}",
      "title": "Human-readable title",
      "tags": ["single_word_tags", "no spaces"]
    }
  ]
}

If none of the candidates are artifacts, respond with: {"artifacts": []}
