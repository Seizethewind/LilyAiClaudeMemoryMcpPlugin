---
name: start-work
description: Use at the start of any task on a repository to load what was done before, unfinished work and the Blueprint. Result is a short briefing, not code.
---
# start-work

**Result:** a briefing (last work, open items, pinned notes, how the repo is built) before anything is changed.

## Tools
`memory_start` `blueprint_get` `memory_search`

## Steps
1. Work out which repository (owner/name) the request is about. Ask if unclear; never guess an owner.
2. `memory_start` with that repository.
3. `blueprint_get` outline first; read only the sections the task touches.
4. `memory_search` only if the briefing points at an earlier attempt you need details of.
5. Tell the user in 3-5 lines what you found and what you will do.

## Don't
- Don't start editing here. Don't store secrets.
