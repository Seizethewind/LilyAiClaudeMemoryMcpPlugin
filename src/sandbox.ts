/**
 * PandaStack tools (https://docs.pandastack.ai) for the MCP server.
 *
 * PandaStack runs Firecracker microVMs. This module exposes its REST API as MCP tools:
 * sandboxes (exec, files, ports, lifecycle, snapshots, forks), templates, volumes,
 * databases, apps, headless Chromium/Playwright, and web search / page fetch that run
 * in a browser VM (PandaStack has no search API of its own).
 *
 * Zero dependencies: Node's built-in fetch. Tools are only registered when a key is set,
 * like memory is only registered with Turso.
 *
 * Env vars:
 *   PANDASTACK_API_KEY            one key, or several separated by commas: "pds_a,pds_b,pds_c".
 *                                 New work rotates through them in order (k1, k2, k3, k1, ...);
 *                                 each sandbox/volume/... stays with the key that created it, and a
 *                                 key that is rate limited or rejected is skipped for a while.
 *                                 PANDASTACK_TOKEN is accepted as an alias.
 *   PANDASTACK_API_URL            default https://api.pandastack.ai
 *   PANDASTACK_PREVIEW_HOST       preview URL suffix; default is the API host without "api."
 *   SANDBOX_MAX_ACTIVE            max live sandboxes this bridge may hold, all keys together (default 3)
 *   SANDBOX_DEFAULT_TTL_SECONDS   lifetime when the caller gives none (default 900)
 *   SANDBOX_MAX_TTL_SECONDS       hard ceiling on any lifetime (default 3600)
 *
 * Every sandbox this bridge creates is tagged metadata.source = "lily-mcp" so the cap
 * only counts its own sandboxes and never touches anything else in the account.
 */
import { ClientOptions, PandaStackClient, PandaStackError, assertAbsPath, assertId, parseKeys } from './pandastack/client';
import { SANDBOX_ANNOTATIONS, SANDBOX_HINT, buildAllTools } from './pandastack/tools';

export type SandboxOptions = ClientOptions & {
  /** "core" (default): the everyday tools plus pandastack_api for everything else. "full": every tool. */
  toolset?: string;
};

/**
 * The everyday set. Every tool's description is sent to Claude at the start of each session, so the
 * full 57 cost roughly 5,500 tokens each time. The core set keeps what real work needs, and
 * pandastack_api reaches every other PandaStack endpoint (snapshots, forks, volumes, databases, apps,
 * lifecycle...) on demand, without carrying their definitions around. SANDBOX_TOOLSET=full lists all of them.
 */
export const CORE_SANDBOX_TOOLS = [
  'pandastack_status', 'sandbox_create', 'sandbox_list', 'sandbox_get', 'sandbox_delete', 'sandbox_exec',
  'sandbox_write_file', 'sandbox_read_file', 'sandbox_list_dir', 'sandbox_preview_url', 'sandbox_browser_screenshot',
  'web_fetch', 'web_search', 'pandastack_api',
];
export { PandaStackClient, PandaStackError, assertAbsPath, assertId, parseKeys, SANDBOX_ANNOTATIONS, SANDBOX_HINT };

export function sandboxOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxOptions {
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    apiKey: env.PANDASTACK_API_KEY || env.PANDASTACK_TOKEN || '',
    apiUrl: env.PANDASTACK_API_URL || undefined,
    previewHost: env.PANDASTACK_PREVIEW_HOST || undefined,
    maxActive: num(env.SANDBOX_MAX_ACTIVE),
    defaultTtlSeconds: num(env.SANDBOX_DEFAULT_TTL_SECONDS),
    maxTtlSeconds: num(env.SANDBOX_MAX_TTL_SECONDS),
    toolset: (env.SANDBOX_TOOLSET || 'core').trim().toLowerCase(),
  };
}

export function buildSandboxTools(opts: SandboxOptions = sandboxOptionsFromEnv()): any[] {
  if (!parseKeys(opts.apiKey).length) return [];
  const all = buildAllTools(new PandaStackClient(opts));
  return opts.toolset === 'full' ? all : all.filter((t) => CORE_SANDBOX_TOOLS.includes(t.name));
}
