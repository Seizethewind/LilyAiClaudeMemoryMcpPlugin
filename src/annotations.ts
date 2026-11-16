/**
 * Behaviour hints per tool name, so MCP clients can ask for confirmation sensibly (e.g. before delete_file)
 * and skip it for pure reads. Keyed by name so tools defined in other modules get them too; tools not
 * listed get no annotations. The server also treats a tool without readOnlyHint=true as one that changes
 * something (write rate limit, read-only keys, use_tool refusal).
 */
import { GATEWAY_ANNOTATIONS } from './gateway';
import { SANDBOX_ANNOTATIONS } from './sandbox';
import { TAVILY_ANNOTATIONS } from './tavily';
import { GITHUB_TOOL_ANNOTATIONS } from './github-tools';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
export const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  get_file_contents: READ_ONLY,
  list_branches: READ_ONLY,
  create_branch: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  create_or_update_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  push_files: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  delete_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  get_breakdown_guide: { readOnlyHint: true, openWorldHint: false },
  get_skill: { readOnlyHint: true, openWorldHint: false },
  memory_start: { readOnlyHint: true, openWorldHint: false },
  memory_repos: { readOnlyHint: true, openWorldHint: false },
  memory_search: { readOnlyHint: true, openWorldHint: false },
  memory_timeline: { readOnlyHint: true, openWorldHint: false },
  memory_get: { readOnlyHint: true, openWorldHint: false },
  memory_trash: { readOnlyHint: true, openWorldHint: false },
  memory_save: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_lock_repo: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_rename_repo: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  blueprint_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  blueprint_save: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  blueprint_history: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  memory_wipe_repo: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  ...SANDBOX_ANNOTATIONS,
  ...GITHUB_TOOL_ANNOTATIONS,
  ...TAVILY_ANNOTATIONS,
  ...GATEWAY_ANNOTATIONS,
};
