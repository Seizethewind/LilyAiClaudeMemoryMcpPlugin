---
name: preview-and-screenshot
description: Use to see a web page or app actually render, in a throwaway sandbox. Result is a screenshot and, if asked, a temporary public preview link.
---
# preview-and-screenshot

**Result:** a screenshot of the page (and a preview URL only if the user wants one).

## Tools
`sandbox_create` `sandbox_write_file` `sandbox_exec` `sandbox_preview_url` `sandbox_browser_screenshot` `sandbox_delete`

## Steps
1. `sandbox_create` with template "browser".
2. `sandbox_write_file` the page or app files into /workspace; `sandbox_exec` to install and start it.
3. `sandbox_browser_screenshot` and describe what is actually visible, including defects.
4. `sandbox_preview_url` only on request, and say the link is public to anyone who has it.
5. `sandbox_delete`.

## Don't
- If starting a server is blocked (403 firewall), report it; don't work around it. Never put secrets in the page.
