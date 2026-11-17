---
name: review-repo
description: Use when asked to break down, audit or explain a repository. Result is a written breakdown saved as the repo's Blueprint.
---
# review-repo

**Result:** a structured explanation of how the repo is built and why, saved to the Blueprint.

## Tools
`get_breakdown_guide` `list_branches` `get_file_contents` `search_code` `list_commits` `blueprint_save`

## Steps
1. `get_breakdown_guide` first and follow it.
2. `list_branches`, then `get_file_contents` on the root and entry points. Use `search_code` to find where something lives instead of opening file after file, and `list_commits` to see what changed recently and why.
3. Write the breakdown; mark anything you did not read.
4. `blueprint_save` each section with `based_on`.

## Don't
- Don't describe code you did not open.
