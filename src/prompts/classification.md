You are classifying files from coding session "{{sessionId}}" to determine which are substantive artifacts worth preserving in a knowledge vault.

## Candidate Files

{{fileList}}

## Task

For each file that is a substantive artifact (design doc, specification, implementation plan, RFC, or documentation), classify it. Skip implementation code, test files, config files, and generated output.

Artifact types:
{{artifactTypes}}

Respond with valid JSON only, no markdown fences:
{
  "artifacts": [
    {
      "source_path": "exact/path/from/above",
      "artifact_type": "{{validTypes}}",
      "title": "Human-readable title",
      "tags": ["relevant", "tags"]
    }
  ]
}

If none of the candidates are artifacts, respond with: {"artifacts": []}
