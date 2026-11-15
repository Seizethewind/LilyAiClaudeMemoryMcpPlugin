---
name: ship-verified-change
description: Advanced ship-a-change. Use when the change must be built and tested for real before the PR is opened. Result is a PR whose description holds actual build and test output.
---
# ship-verified-change

**Result:** a pull request with real build/test results in its description. Extends ship-a-change with a sandbox check.

## Tools
`list_branches` `create_branch` `get_file_contents` `push_files` `pr_create` `actions_runs` `sandbox_create` `sandbox_exec` `sandbox_delete`

## Steps
1. Do ship-a-change steps 1-3 (branch, read, push).
2. `sandbox_create`; in it clone the branch, run `yarn install && yarn build && npm test` with `sandbox_exec`.
3. Copy the real pass/fail counts into the PR body; if it fails, fix on the branch and re-run.
4. `pr_create`, then `actions_runs`.
5. `sandbox_delete` always, even after a failure.

## Don't
- Never write "tests pass" without having run them. Starting servers in the sandbox may be blocked; test with files, not a live server.
