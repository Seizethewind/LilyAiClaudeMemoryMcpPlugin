/**
 * /admin/memory: the only place where memory can be wiped server-wide, erased
 * for good (empty trash) or unlocked. There is deliberately no MCP tool for any
 * of this, so neither a confused model nor a prompt injection hidden in repo or
 * memory content can reach it: it takes the admin secret, typed by a person.
 *
 * Session = a short-lived signed cookie (HttpOnly, SameSite=Strict, scoped to
 * /admin/memory) that also carries a CSRF token every form must echo back.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryStore, normalizeRepo } from './memory';

export interface AdminDeps {
  store: () => MemoryStore | null;
  /** Constant-time comparison against the admin secret. */
  checkSecret: (candidate: string) => boolean;
  safeEqual: (a: string, b: string) => boolean;
  sign: (payload: Record<string, unknown>, seconds: number) => string;
  verify: (token: string) => Record<string, any> | null;
  readBody: (req: IncomingMessage) => Promise<string>;
  clientIp: (req: IncomingMessage) => string;
  limiter: { lockedOut(ip: string): boolean; recordFailure(ip: string): void; clear(ip: string): void };
  secureCookies: boolean;
}

export const PHRASE_WIPE_ALL = 'WIPE ALL MEMORY';
export const PHRASE_EMPTY_TRASH = 'EMPTY TRASH';

const SESSION_COOKIE = 'lily_admin';
const FLASH_COOKIE = 'lily_flash';
const SESSION_SECONDS = 15 * 60;
const BASE = '/admin/memory';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const STYLE = `
  :root{color-scheme:light dark;--bg:#fafafa;--fg:#1a1a1a;--mut:#6b6b6b;--card:#fff;--line:#e2e2e2;--acc:#2456d6;--bad:#b42318;--ok:#067647}
  @media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--mut:#9a9a9a;--card:#1c1c1c;--line:#333;--acc:#7da3ff;--bad:#ff8a80;--ok:#6ee7a8}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
  main{max-width:960px;margin:0 auto;padding:20px 16px 60px}h1{font-size:1.35rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px}
  p,.mut{color:var(--mut)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
  table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600}.scroll{overflow-x:auto}
  input[type=text],input[type=password],select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);max-width:100%}
  button{font:inherit;padding:7px 12px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
  button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{border-color:var(--bad);color:var(--bad)}
  .badge{display:inline-block;padding:0 7px;border-radius:99px;border:1px solid var(--line);font-size:.78rem}
  .flash{border-left:4px solid var(--acc)}.flash.err{border-left-color:var(--bad)}.danger-zone{border-color:var(--bad)}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px}code{font-size:.85rem}
  form.inline{display:inline}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(msg: string): string {
  return page(
    'Memory admin',
    `<h1>Memory admin</h1><p>Wipe, erase and unlock operations live here only. Claude has no tool for them.</p>
     ${msg ? `<div class="card flash err">${esc(msg)}</div>` : ''}
     <form class="card" method="post" action="${BASE}/login" autocomplete="off">
       <label>Admin secret<br><input type="password" name="secret" autofocus required style="width:100%;margin-top:6px"></label>
       <div class="row"><button class="primary" type="submit">Sign in</button></div>
     </form>`
  );
}

export function createMemoryAdmin(deps: AdminDeps) {
  const headers = (extra: Record<string, string | string[]> = {}) => ({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
  const cookieAttrs = (maxAge: number) => `HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=${maxAge}${deps.secureCookies ? '; Secure' : ''}`;

  function html(res: ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}) {
    res.writeHead(status, { ...headers(extra), 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function redirect(res: ServerResponse, extra: Record<string, string | string[]> = {}) {
    res.writeHead(303, { Location: BASE, 'Cache-Control': 'no-store', ...extra });
    res.end();
  }
  function session(req: IncomingMessage): { csrf: string } | null {
    const tok = cookies(req)[SESSION_COOKIE];
    const claims = tok ? deps.verify(tok) : null;
    return claims && claims.typ === 'admin' && typeof claims.csrf === 'string' ? { csrf: claims.csrf } : null;
  }

  async function dashboard(req: IncomingMessage, res: ServerResponse, sess: { csrf: string }) {
    const store = deps.store();
    const flash = cookies(req)[FLASH_COOKIE] || '';
    const clearFlash = `${FLASH_COOKIE}=; ${cookieAttrs(0)}`;
    const csrf = `<input type="hidden" name="csrf" value="${esc(sess.csrf)}">`;
    const flashHtml = flash ? `<div class="card flash ${flash.startsWith('Error') ? 'err' : ''}">${esc(flash)}</div>` : '';
    if (!store) {
      return html(res, 200, page('Memory admin', `<h1>Memory admin</h1>${flashHtml}<div class="card">Memory is not configured on this server (no TURSO_DATABASE_URL), so there is nothing to manage.</div>`), { 'Set-Cookie': clearFlash });
    }
    const s = await store.adminSummary();
    const locked = s.repos.filter((r) => r.locked);
    const lockedEntries = locked.reduce((n, r) => n + r.entries, 0);

    const repoRows = s.repos.length
      ? s.repos.map((r) => `<tr><td><code>${esc(r.repo)}</code></td><td>${r.entries}</td><td>${r.unfinished}</td><td>${r.in_trash}</td><td>${r.blueprint === null ? '' : 'v' + r.blueprint}</td>
          <td>${r.locked ? '<span class="badge">locked</span>' : ''}</td>
          <td><form class="inline" method="post" action="${BASE}/action">${csrf}<input type="hidden" name="repo" value="${esc(r.repo)}">
            <button name="action" value="${r.locked ? 'unlock' : 'lock'}">${r.locked ? 'Unlock' : 'Lock'}</button></form>
            ${r.blueprint === null ? '' : `<form class="inline" method="post" action="${BASE}/action">${csrf}<input type="hidden" name="repo" value="${esc(r.repo)}"><input name="phrase" placeholder="DELETE BLUEPRINT ${esc(r.repo)}" size="28" autocomplete="off"><button name="action" value="delete_blueprint">Delete blueprint</button></form>`}</td></tr>`).join('')
      : '<tr><td colspan="7" class="mut">No repositories yet.</td></tr>';

    const trashRows = s.trash.batches.length
      ? s.trash.batches.map((b: any) => `<tr><td><code>${esc(b.batch ?? 'legacy')}</code></td><td><code>${esc(b.repo)}</code></td><td>${b.entries}</td><td>${esc(b.removed_at)}</td><td>${esc(b.erased_after)}</td>
          <td>${b.batch ? `<form class="inline" method="post" action="${BASE}/action">${csrf}<input type="hidden" name="batch" value="${esc(b.batch)}"><button name="action" value="restore_batch">Restore</button></form>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6" class="mut">The trash is empty.</td></tr>';

    const auditRows = s.audit.length
      ? s.audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td><code>${esc(a.repo ?? '')}</code></td><td class="mut">${esc(a.detail ?? '')}</td></tr>`).join('')
      : '<tr><td colspan="5" class="mut">Nothing recorded yet.</td></tr>';

    const repoOptions = s.repos.map((r) => `<option value="${esc(r.repo)}">${esc(r.repo)} (${r.in_trash} in trash)</option>`).join('');

    const body = `
      <div class="row" style="justify-content:space-between"><div><h1>Memory admin</h1>
        <span class="mut">${s.live} entries in ${s.repos.length} repositories, ${s.trashed} in trash (erased automatically after ${s.retention_days} days)</span></div>
        <form method="post" action="${BASE}/logout">${csrf}<button>Sign out</button></form></div>
      ${flashHtml}

      <h2>Repositories</h2>
      <div class="card scroll"><table><tr><th>Repository</th><th>Entries</th><th>Unfinished</th><th>In trash</th><th>Blueprint</th><th></th><th></th></tr>${repoRows}</table>
        <p class="mut">A locked repository cannot be wiped or renamed by Claude. Only you can unlock it here.</p></div>

      <h2>Trash</h2>
      <div class="card scroll"><table><tr><th>Batch</th><th>Repository</th><th>Entries</th><th>Removed (UTC)</th><th>Erased after</th><th></th></tr>${trashRows}</table></div>

      <h2>Danger zone</h2>
      <form class="card danger-zone" method="post" action="${BASE}/action">${csrf}<input type="hidden" name="action" value="wipe_all">
        <strong>Wipe all memory</strong>
        <p>Moves every entry of every repository to the trash (restorable for ${s.retention_days} days). Currently ${s.live} entries${lockedEntries ? `, ${lockedEntries} of them in locked repositories, which are skipped unless ticked below` : ''}. Pinned entries are skipped unless ticked.</p>
        <div class="row"><label><input type="checkbox" name="include_locked" value="1"> include locked repositories</label>
        <label><input type="checkbox" name="include_pinned" value="1"> include pinned entries</label></div>
        <div class="row"><input type="text" name="phrase" placeholder="type ${PHRASE_WIPE_ALL}" autocomplete="off" size="26"><button class="danger" type="submit">Wipe all</button></div></form>

      <form class="card danger-zone" method="post" action="${BASE}/action">${csrf}<input type="hidden" name="action" value="empty_trash">
        <strong>Empty trash (permanent)</strong>
        <p>Erases trashed entries for good. This cannot be undone. Copies already pushed to the GitHub backup stay in that repository's history.</p>
        <div class="row"><select name="scope"><option value="">everything in the trash (${s.trashed} entries)</option>${repoOptions}</select>
        <input type="text" name="phrase" placeholder="type ${PHRASE_EMPTY_TRASH}" autocomplete="off" size="22"><button class="danger" type="submit">Erase permanently</button></div></form>

      <h2>Recent activity</h2>
      <div class="card scroll"><table><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Repository</th><th>Detail</th></tr>${auditRows}</table></div>`;
    html(res, 200, page('Memory admin', body), { 'Set-Cookie': clearFlash });
  }

  async function perform(form: URLSearchParams): Promise<string> {
    const store = deps.store();
    if (!store) throw new Error('memory is not configured');
    const action = form.get('action');
    switch (action) {
      case 'lock':
      case 'unlock': {
        const { key } = normalizeRepo(form.get('repo'));
        if (action === 'lock') await store.lockRepo({ repo: key }, 'admin');
        else await store.unlockRepo(key, 'admin');
        return `${action === 'lock' ? 'Locked' : 'Unlocked'} ${key}.`;
      }
      case 'delete_blueprint': {
        const { key } = normalizeRepo(form.get('repo'));
        if ((form.get('phrase') || '').trim() !== `DELETE BLUEPRINT ${key}`) throw new Error(`type DELETE BLUEPRINT ${key} exactly to confirm. Nothing was deleted.`);
        await store.deleteBlueprint(key, 'admin');
        return `Deleted the blueprint of ${key}, including its history.`;
      }
      case 'restore_batch': {
        const r = await store.restoreBatch(String(form.get('batch') || ''), 'admin');
        return `Restored ${r.restored} entries.`;
      }
      case 'empty_trash': {
        if ((form.get('phrase') || '').trim() !== PHRASE_EMPTY_TRASH) throw new Error(`type ${PHRASE_EMPTY_TRASH} exactly to confirm. Nothing was erased.`);
        const scope = (form.get('scope') || '').trim();
        const r = await store.emptyTrash(scope ? { repo: scope } : {}, 'admin');
        return `Permanently erased ${r.erased} entries${scope ? ` of ${scope}` : ''}.`;
      }
      case 'wipe_all': {
        if ((form.get('phrase') || '').trim() !== PHRASE_WIPE_ALL) throw new Error(`type ${PHRASE_WIPE_ALL} exactly to confirm. Nothing was wiped.`);
        const r = await store.wipeAll({ includeLocked: form.get('include_locked') === '1', includePinned: form.get('include_pinned') === '1' }, 'admin');
        return `Moved ${r.wiped} entries to the trash (batch ${r.batch}). Restore them from the Trash table.`;
      }
      default:
        throw new Error('unknown action');
    }
  }

  /** Returns true when the request was for an admin route (and has been answered). */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
    const method = req.method || 'GET';

    if (path === BASE && method === 'GET') {
      const sess = session(req);
      if (!sess) html(res, 200, loginPage(''));
      else await dashboard(req, res, sess);
      return true;
    }

    if (path === `${BASE}/login` && method === 'POST') {
      const ip = deps.clientIp(req);
      if (deps.limiter.lockedOut(ip)) {
        html(res, 429, loginPage('Too many failed attempts. Try again in a while.'));
        return true;
      }
      const form = new URLSearchParams(await deps.readBody(req));
      if (!deps.checkSecret(form.get('secret') || '')) {
        deps.limiter.recordFailure(ip);
        html(res, 401, loginPage('Wrong secret.'));
        return true;
      }
      deps.limiter.clear(ip);
      const token = deps.sign({ typ: 'admin', csrf: randomBytes(16).toString('hex') }, SESSION_SECONDS);
      redirect(res, { 'Set-Cookie': `${SESSION_COOKIE}=${token}; ${cookieAttrs(SESSION_SECONDS)}` });
      return true;
    }

    if ((path === `${BASE}/action` || path === `${BASE}/logout`) && method === 'POST') {
      const sess = session(req);
      if (!sess) {
        redirect(res);
        return true;
      }
      const form = new URLSearchParams(await deps.readBody(req));
      if (!deps.safeEqual(form.get('csrf') || '', sess.csrf)) {
        html(res, 403, loginPage('Session check failed. Sign in again.'));
        return true;
      }
      if (path === `${BASE}/logout`) {
        redirect(res, { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(0)}` });
        return true;
      }
      let msg: string;
      try {
        msg = await perform(form);
      } catch (err: any) {
        msg = `Error: ${err.message}`;
      }
      redirect(res, { 'Set-Cookie': `${FLASH_COOKIE}=${encodeURIComponent(msg.slice(0, 300))}; ${cookieAttrs(60)}` });
      return true;
    }

    html(res, 404, page('Not found', '<h1>Not found</h1>'));
    return true;
  };
}
