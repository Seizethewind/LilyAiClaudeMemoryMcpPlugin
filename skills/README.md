# Skills

Process skills for this MCP server. Each one is named after a job, lists the tools it combines and states the result it produces. Upload a folder to Claude (or package them as a plugin) to use it.

| Skill | Result |
|---|---|
| start-work | briefing before work |
| finish-work | outcome + Blueprint recorded |
| ship-a-change | open PR + CI status |
| ship-verified-change | advanced: PR with real build/test output |
| verify-in-sandbox | pass/fail report for a ref |
| fix-failing-ci | diagnosed cause + fix commit |
| review-repo | breakdown saved as Blueprint |
| review-pull-request | review comments + verdict |
| triage-issues | ranked open issues |
| research-cheaply | cited answer, minimal credits |
| preview-and-screenshot | screenshot of a running page |
| memory-housekeeping | tidy memory, on request only |

Rules (enforced by `tests/skills.test.ts`): frontmatter is only `name` and `description`; a `## Tools` line lists real tools; two skills differ by at least 2 tools unless one is a strict superset (the advanced version).

## Using them
- **Any session with the connector:** the server serves these files through `get_skill` (no name lists them; a name returns the full skill). Only the skill names sit in the always-on instructions.
- Folders are the single source of truth: change a `SKILL.md`, redeploy, and `get_skill` serves the new text.
