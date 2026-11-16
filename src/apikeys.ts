/**
 * Static access keys for clients that cannot do the browser sign-in (terminal tools, scripts, your own apps).
 *
 *   MCP_API_KEYS = label=secret, label2:read=secret2
 *
 * The client sends  Authorization: Bearer <secret>  to /mcp. A key is "full" (default) or "read"; a read key
 * can only run tools that do not change anything. Secrets must be at least 32 characters; shorter ones and
 * placeholders are refused at startup. Secrets are never logged or stored: only a SHA-256 digest is kept in
 * memory, compared in constant time, and the label (not the secret) shows up in the logs and the audit line.
 * Rotate a key by changing the env var; it stays valid until you do.
 */
import * as crypto from 'node:crypto';

export type ApiKey = { label: string; scope: 'full' | 'read'; digest: Buffer };

const PLACEHOLDER = /^(not[_ -]?set|none|null|undefined|n\/a|changeme|change[_ -]?me|placeholder|your[_ -]?key|x{3,})$/i;
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

export function parseApiKeys(raw: string | undefined): { keys: ApiKey[]; warnings: string[] } {
  const keys: ApiKey[] = [];
  const warnings: string[] = [];
  for (const part of String(raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 1) {
      warnings.push('an entry is not in label=secret form and was ignored');
      continue;
    }
    const [labelRaw, scopeRaw] = part.slice(0, eq).trim().split(':');
    const secret = part.slice(eq + 1).trim();
    const label = labelRaw.trim();
    const scope = (scopeRaw || 'full').trim().toLowerCase();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(label)) warnings.push(`label "${label.slice(0, 40)}" is not allowed (letters, digits, _ . - up to 40) and was ignored`);
    else if (scope !== 'full' && scope !== 'read') warnings.push(`key "${label}": scope must be full or read, so it was ignored`);
    else if (PLACEHOLDER.test(secret)) continue; // a placeholder means "no key", like the other optional settings
    else if (secret.length < 32) warnings.push(`key "${label}" is shorter than 32 characters and was ignored`);
    else if (keys.some((k) => k.label === label)) warnings.push(`key "${label}" appears twice; the first one is used`);
    else keys.push({ label, scope: scope as 'full' | 'read', digest: sha(secret) });
  }
  return { keys, warnings };
}

/** The matching key, or null. Every key is compared, so the time taken does not reveal which one matched. */
export function authenticateApiKey(token: string, keys: ApiKey[]): ApiKey | null {
  if (!keys.length || !token) return null;
  const d = sha(token);
  let hit: ApiKey | null = null;
  for (const k of keys) if (crypto.timingSafeEqual(d, k.digest) && !hit) hit = k;
  return hit;
}
