---
name: verify-in-sandbox
description: Use to check whether a branch or commit really builds and passes tests on a clean machine, without opening a PR. Result is a pass/fail report.
---
# verify-in-sandbox

**Result:** a plain pass/fail report (install, build, test counts) for one ref. No PR, no changes pushed.

## Tools
`pandastack_status` `sandbox_create` `sandbox_exec` `sandbox_read_file` `sandbox_delete`

## Steps
1. `pandastack_status` to confirm keys and the active-sandbox cap.
2. `sandbox_create`, clone the ref, run install, build, tests via `sandbox_exec`.
3. `sandbox_read_file` for long logs; quote only the failing lines.
4. `sandbox_delete`.
5. Report counts and the first real error.

## Don't
- Don't retry a 403 "firewall" refusal another way; report it.
