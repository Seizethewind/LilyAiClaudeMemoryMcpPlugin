/**
 * Tool gateway: keeps the always-loaded tool list small.
 *
 * Only a basic set of tools (plus three gateway tools) is announced in tools/list. Every other tool
 * still exists and can be reached on demand:
 *   find_tools      - lists hidden tools by group/keyword, with their full schemas
 *   use_tool        - runs a hidden READ-ONLY tool (enforced here, so its read-only hint is truthful)
 *   use_write_tool  - runs any other hidden tool (declared destructive, so clients can ask first)
 *
 * The gateway adds no new powers: a call is unwrapped and goes through the same dispatch, the same
 * handler, the same repo allowlists and the same audit log line as a direct call. Hidden tools can
 * also still be called directly by name (clients with a cached tool list keep working).
 * TOOL_MODE=full switches the gateway off and lists every tool as before.
 */

export const BASIC_TOOLS = [
  'get_file_contents',
  'create_branch',
  'create_or_update_file',
  'push_files',
  'pr_create',
  'pr_get',
  'get_breakdown_guide',
  'get_skill',
  'memory_start',
  'memory_save',
  'memory_update',
  'web_search',
];

export const GATEWAY_TOOL_NAMES = ['find_tools', 'use_tool', 'use_write_tool'];

export const GATEWAY_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  find_tools: { readOnlyHint: true, openWorldHint: false },
  use_tool: { readOnlyHint: true, openWorldHint: true },
  use_write_tool: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const GATEWAY_HINT =
  'To keep context small, only the everyday tools are listed. Others (issues, Actions, more PR tools, blueprint, memory search and housekeeping, sandbox, web extract/map) are hidden but available: call find_tools (optionally with a group or keyword) to see them with their schemas, then use_tool for a read-only one or use_write_tool for anything that changes something. Skills name hidden tools too; use the same route.';

export type ToolMode = 'gateway' | 'full';
export const toolMode = (v: string | undefined = process.env.TOOL_MODE): ToolMode => (String(v || '').toLowerCase() === 'full' ? 'full' : 'gateway');

export function toolGroup(name: string): string {
  if (name.startsWith('pr_')) return 'pr';
  if (name.startsWith('issue_')) return 'issue';
  if (name.startsWith('actions_')) return 'actions';
  if (name.startsWith('memory_')) return 'memory';
  if (name.startsWith('blueprint_')) return 'blueprint';
  if (name.startsWith('sandbox_') || name.startsWith('pandastack_')) return 'sandbox';
  if (name.startsWith('web_')) return 'web';
  return 'repo';
}

const isGateway = (n: string) => GATEWAY_TOOL_NAMES.includes(n);

/** What tools/list announces. */
export function visibleTools(all: any[], mode: ToolMode): any[] {
  if (mode === 'full') return all.filter((t) => !isGateway(t.name));
  const basic = new Set(BASIC_TOOLS);
  return all.filter((t) => basic.has(t.name) || isGateway(t.name));
}

export function buildGatewayTools(getTools: () => any[], getAnnotations: () => Record<string, Record<string, boolean>>): any[] {
  const hidden = () => {
    const basic = new Set(BASIC_TOOLS);
    return getTools().filter((t) => !basic.has(t.name) && !isGateway(t.name));
  };
  const notDirect = async () => {
    throw new Error('Gateway calls are unwrapped by the server before they reach a handler.');
  };
  return [
    {
      name: 'find_tools',
      description:
        'Lists tools that are hidden to save context. With no arguments: the groups and tool names. With a group (pr, issue, actions, memory, blueprint, sandbox, web, repo) or a keyword: the full description and input schema of the matching tools, ready for use_tool / use_write_tool.',
      inputSchema: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'pr, issue, actions, memory, blueprint, sandbox, web or repo.' },
          query: { type: 'string', description: 'Keyword matched against tool names and descriptions.' },
        },
        required: [],
      },
      handler: async ({ group, query }: { group?: string; query?: string }) => {
        const ann = getAnnotations();
        const tools = hidden();
        const g = group ? String(group).toLowerCase() : '';
        const q = query ? String(query).toLowerCase() : '';
        if (!g && !q) {
          const groups: Record<string, string[]> = {};
          for (const t of tools) (groups[toolGroup(t.name)] ||= []).push(t.name);
          return { visible: 'always listed: ' + BASIC_TOOLS.join(', '), hidden_groups: groups };
        }
        const hit = tools.filter(
          (t) => (!g || toolGroup(t.name) === g) && (!q || t.name.toLowerCase().includes(q) || String(t.description).toLowerCase().includes(q)),
        );
        return {
          tools: hit.map((t) => ({
            name: t.name,
            group: toolGroup(t.name),
            call_with: ann[t.name]?.readOnlyHint === true ? 'use_tool' : 'use_write_tool',
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      },
    },
    {
      name: 'use_tool',
      description: 'Runs a hidden READ-ONLY tool. Arguments: name (from find_tools) and arguments (that tool\'s own input). Refuses tools that change anything.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: { type: 'object', description: "The hidden tool's own input." } },
        required: ['name'],
      },
      handler: notDirect,
    },
    {
      name: 'use_write_tool',
      description: 'Runs a hidden tool that may change something (create, update, delete, run). Arguments: name (from find_tools) and arguments (that tool\'s own input).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: { type: 'object', description: "The hidden tool's own input." } },
        required: ['name'],
      },
      handler: notDirect,
    },
  ];
}

/** Turns a use_tool / use_write_tool call into the call it wraps; any other call passes through. */
export function unwrap(
  name: string,
  args: any,
  all: any[],
  annotations: Record<string, Record<string, boolean>>,
): { name: string; args: any } {
  if (name !== 'use_tool' && name !== 'use_write_tool') return { name, args };
  const inner = args && args.name;
  if (typeof inner !== 'string' || !inner) throw new Error('"name" is required. Use find_tools to see the available tools.');
  if (isGateway(inner)) throw new Error(`${inner} cannot be called through the gateway.`);
  if (!all.some((t) => t.name === inner)) throw new Error(`Unknown tool: ${inner}. Use find_tools to see the available tools.`);
  const innerArgs = args.arguments === undefined ? {} : args.arguments;
  if (!innerArgs || typeof innerArgs !== 'object' || Array.isArray(innerArgs)) throw new Error('"arguments" must be an object.');
  if (name === 'use_tool' && annotations[inner]?.readOnlyHint !== true) {
    throw new Error(`${inner} is not read-only. Call it with use_write_tool.`);
  }
  return { name: inner, args: innerArgs };
}
