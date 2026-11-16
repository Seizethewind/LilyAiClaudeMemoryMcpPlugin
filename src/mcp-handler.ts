/**
 * The /mcp endpoint: authentication (OAuth access token or a static access key), JSON-RPC routing
 * (initialize, tools/list, tools/call, prompts), the gateway unwrap, read-only key scope, rate limits and
 * the log/audit lines. Moved out of server.ts as is; createMcpHandler takes what it needs from the wiring.
 */
import { verifyJwt } from './jwt';
import { clientIp, sendJson, readBody, getBearerToken, PayloadTooLargeError } from './http-util';
import { authenticateApiKey, type ApiKey } from './apikeys';
import { PROMPTS, getPrompt } from './guide';
import { visibleTools, unwrap, type ToolMode } from './gateway';
import { auditLine, type CallGuard } from './guard';

export type McpDeps = {
  jwtSecret: string | undefined;
  baseUrl: string;
  apiKeys: ApiKey[];
  /** The live tool list; tools may be added after start-up (memory), so the array itself is shared. */
  tools: any[];
  annotations: Record<string, Record<string, boolean>>;
  toolMode: ToolMode;
  callGuard: CallGuard;
  /** True for tools that talk to GitHub; their writes get an [audit] line. */
  isGithubTool: (name: string) => boolean;
  /** Server instructions, built on each initialize because memory may become available after start-up. */
  instructions: () => string;
};

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function createMcpHandler(deps: McpDeps) {
  const JWT_SECRET = deps.jwtSecret as string;
  const BASE_URL = deps.baseUrl;
  const API_KEYS = deps.apiKeys;
  const TOOLS = deps.tools;
  const TOOL_ANNOTATIONS = deps.annotations;
  const TOOL_MODE = deps.toolMode;
  const callGuard = deps.callGuard;

  return async function handleMcp(req, res) {
    const token = getBearerToken(req);
    // A static access key (MCP_API_KEYS) is an alternative to the OAuth access token, for clients that cannot browse.
    const apiKey = token ? authenticateApiKey(token, API_KEYS) : null;
    const claims = token && !apiKey ? verifyJwt(token, JWT_SECRET) : null;
    // Only access tokens may call /mcp: refresh tokens and the admin page's
    // session cookie are signed with the same secret and must never work here.
    if (!apiKey && (!claims || claims.typ !== 'access')) {
      // Point the client at our protected-resource metadata so it knows
      // where to go to authenticate (required for MCP OAuth discovery).
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
      return;
    }

    // Who is calling, for rate limits and logs: a key client by label, everyone else by IP.
    const who = apiKey ? `key:${apiKey.label}` : clientIp(req);
    const clientTag = apiKey ? ` client=${apiKey.label}` : '';
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof PayloadTooLargeError) throw e; // let the outer handler send a proper 413
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.method !== 'string') {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
      return;
    }

    const { id, method, params } = payload;

    // Notifications (no id, e.g. notifications/initialized) get no JSON-RPC
    // response: acknowledge with 202 and an empty body, as the Streamable HTTP
    // transport specifies.
    if (id === undefined || id === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      if (method === 'ping') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'initialize') {
        // Echo the client's protocol version when we support it, otherwise offer our newest.
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: 'lily-github-mcp-bridge', version: '2.0.0' },
            instructions: deps.instructions(),
          },
        });
        return;
      }

      if (method === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: visibleTools(TOOLS, TOOL_MODE).map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
              ...(TOOL_ANNOTATIONS[name] ? { annotations: TOOL_ANNOTATIONS[name] } : {}),
            })),
          },
        });
        return;
      }

      if (method === 'prompts/list') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { prompts: PROMPTS } });
        return;
      }

      if (method === 'prompts/get') {
        const prompt = getPrompt(params && params.name, params && params.arguments);
        if (!prompt) {
          sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params && params.name}` } });
          return;
        }
        sendJson(res, 200, { jsonrpc: '2.0', id, result: prompt });
        return;
      }

      if (method === 'tools/call') {
        if (!params || typeof params.name !== 'string') {
          sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: "name" is required' } });
          return;
        }
        let callName: string = params.name;
        let args: any = params.arguments || {};
        if (TOOL_MODE === 'gateway' && (callName === 'use_tool' || callName === 'use_write_tool')) {
          try {
            ({ name: callName, args } = unwrap(callName, args, TOOLS, TOOL_ANNOTATIONS));
          } catch (err: any) {
            console.log(`[tools/call] ${new Date().toISOString()} ip=${clientIp(req)}${clientTag} tool=${params.name} status=error message=${err.message}`);
            sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
            return;
          }
        }
        const tool = TOOLS.find((t) => t.name === callName);
        if (!tool) {
          sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${callName}` } });
          return;
        }
        const writes = TOOL_ANNOTATIONS[callName]?.readOnlyHint !== true;
        if (apiKey && apiKey.scope === 'read' && writes) {
          console.log(`[tools/call] ${new Date().toISOString()} ip=${clientIp(req)}${clientTag} tool=${callName} status=forbidden`);
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: this access key is read-only, so ${callName} is not allowed. Use a full key for tools that change something.` }], isError: true } });
          return;
        }
        const refused = callGuard.check(who, writes);
        if (refused) {
          console.log(`[tools/call] ${new Date().toISOString()} ip=${clientIp(req)}${clientTag} tool=${callName} status=rate_limited`);
          sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${refused}` }], isError: true } });
          return;
        }
        // GitHub writes get a structured [audit] line as well (names and counts, never contents).
        const auditWrite = writes && deps.isGithubTool(callName);
        const via = callName !== params.name ? params.name : undefined;
        // Not a persisted audit log (stdout only, subject to Render's log
        // retention) but enough to answer "who touched what repo, and when" by
        // grepping deploy logs after the fact.
        const target = args.owner && args.repo ? `${args.owner}/${args.repo}` : typeof args.repo === 'string' ? args.repo.slice(0, 100) : '-';
        const logLine = `[tools/call] ${new Date().toISOString()} ip=${clientIp(req)}${clientTag} tool=${callName}${callName !== params.name ? ` via=${params.name}` : ''} repo=${target}`;
        try {
          const result = await tool.handler(args);
          console.log(`${logLine} status=ok`);
          if (auditWrite) console.log(auditLine({ ip: clientIp(req), client: apiKey?.label, tool: callName, via, args, ok: true }));
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          });
        } catch (err) {
          console.log(`${logLine} status=error message=${err.message}`);
          if (auditWrite) console.log(auditLine({ ip: clientIp(req), client: apiKey?.label, tool: callName, via, args, ok: false, error: err.message }));
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
          });
        }
        return;
      }

      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    } catch (err) {
      sendJson(res, 500, { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
    }
  }
}
