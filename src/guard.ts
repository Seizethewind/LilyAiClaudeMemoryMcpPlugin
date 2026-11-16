/**
 * Two protections for /mcp tool calls:
 *
 *  1. Rate limits per client IP (in memory, per minute): one for all calls, a tighter one for calls that
 *     change something. Over the limit the call is refused with a plain tool error, before any handler
 *     or GitHub request runs. MCP_RATE_LIMIT_PER_MIN (default 120) and MCP_WRITE_LIMIT_PER_MIN (default 30);
 *     0 switches that limit off.
 *  2. An audit line for every GitHub write (commit, delete, branch, PR, issue, rerun): who, what, where,
 *     result. It carries names, paths and counts, never file contents or comment bodies. It goes to
 *     stdout, so it lasts as long as Render keeps the logs.
 */
import { makeRateLimiter } from './http-util';
import { redact } from './memory';

export type CallGuard = { check(ip: string, isWrite: boolean): string | null };

export function createCallGuard(opts: { perMin: number; writePerMin: number }): CallGuard {
  const all = opts.perMin > 0 ? makeRateLimiter({ windowMs: 60_000, maxPerIp: opts.perMin, maxGlobal: opts.perMin * 2 }) : null;
  const writes = opts.writePerMin > 0 ? makeRateLimiter({ windowMs: 60_000, maxPerIp: opts.writePerMin, maxGlobal: opts.writePerMin * 2 }) : null;
  return {
    /** null = go ahead (and the call is counted); a string = refused, with the reason to show. */
    check(ip, isWrite) {
      if (all && all.lockedOut(ip)) return `Rate limit reached (${opts.perMin} tool calls per minute). Wait about a minute and try again.`;
      if (isWrite && writes && writes.lockedOut(ip)) return `Write limit reached (${opts.writePerMin} changing calls per minute). Wait about a minute and try again.`;
      all?.recordFailure(ip);
      if (isWrite) writes?.recordFailure(ip);
      return null;
    },
  };
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);

export function callGuardFromEnv(env: NodeJS.ProcessEnv = process.env): CallGuard {
  return createCallGuard({ perMin: num(env.MCP_RATE_LIMIT_PER_MIN, 120), writePerMin: num(env.MCP_WRITE_LIMIT_PER_MIN, 30) });
}

const cut = (v: unknown, n: number) => String(v).slice(0, n);

/** One structured line describing a GitHub write. Never includes contents, messages or comment bodies. */
export function auditLine(e: { ip: string; client?: string; tool: string; via?: string; args: any; ok: boolean; error?: string; now?: Date }): string {
  const a = e.args || {};
  const rec: Record<string, unknown> = {
    ts: (e.now || new Date()).toISOString(),
    ip: e.ip,
    ...(e.client ? { client: e.client } : {}),
    tool: e.tool,
    ...(e.via ? { via: e.via } : {}),
    repo: a.owner && a.repo ? `${a.owner}/${a.repo}` : '-',
    ...(typeof a.branch === 'string' ? { branch: cut(a.branch, 200) } : {}),
    ...(typeof a.head === 'string' ? { head: cut(a.head, 200) } : {}),
    ...(typeof a.base === 'string' ? { base: cut(a.base, 200) } : {}),
    ...(typeof a.path === 'string' ? { path: cut(a.path, 300) } : {}),
    ...(Array.isArray(a.files) ? { files: a.files.length } : {}),
    ...(a.number !== undefined ? { number: Number(a.number) } : {}),
    ...(a.run_id !== undefined ? { run_id: Number(a.run_id) } : {}),
    result: e.ok ? 'ok' : 'error',
    ...(e.ok ? {} : { error: redact(cut(e.error || "", 300)).text }),
  };
  return `[audit] ${JSON.stringify(rec)}`;
}
