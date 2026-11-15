---
name: ship-a-change
description: Use to deliver a code change as a pull request on a branch and report its CI result. Result is an open PR; merging is left to the user.
---
# ship-a-change

**Result:** an open pull request from a new branch, plus the CI status.

## Tools
`list_branches` `create_branch` `get_file_contents` `push_files` `pr_create` `actions_runs`

## Steps
1. `list_branches`, then `create_branch` off the default branch. Default-branch writes are blocked.
2. `get_file_contents` for every file you will change; keep edits small.
3. `push_files` all changes in one commit.
4. `pr_create` with what changed and why.
5. `actions_runs` for the branch; report the result as it is.

## Don't
- Never merge or approve. If CI fails, switch to fix-failing-ci.
