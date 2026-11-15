---
name: memory-housekeeping
description: Use only when the user asks to tidy, find or remove stored memory. Result is a short report of what was found and what was removed or restored.
---
# memory-housekeeping

**Result:** which repositories and entries exist, and exactly what was forgotten or restored at the user's request.

## Tools
`memory_repos` `memory_timeline` `memory_get` `memory_forget` `memory_trash` `memory_restore`

## Steps
1. `memory_repos`, then `memory_timeline` for the repository in question.
2. `memory_get` the entries you are unsure about and show them.
3. `memory_forget` only entries the user named; they go to the trash.
4. `memory_trash` to list and `memory_restore` to undo a mistake.

## Don't
- Never remove anything unasked. Wiping a repository or all memory is the user's call (admin page), not this skill's.
