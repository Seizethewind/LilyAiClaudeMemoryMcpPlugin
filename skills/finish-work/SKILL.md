---
name: finish-work
description: Use when a task is done to record what actually happened and keep the Blueprint true. Result is an updated memory entry and Blueprint sections.
---
# finish-work

**Result:** memory entry closed with the real outcome; Blueprint sections updated in place.

## Tools
`memory_update` `blueprint_save` `blueprint_get`

## Steps
1. `memory_update` with the result (what happened, including failures) and a status.
2. `blueprint_get` to read the current version of the sections you changed.
3. `blueprint_save` the affected sections only, passing `based_on` (commit) and `base_version`.
4. On a version conflict, re-read, merge, retry once.

## Don't
- Record only what you verified. Never invent reasons or claim tests you did not run.
