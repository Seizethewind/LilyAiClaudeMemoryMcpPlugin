/** Small helpers shared by the memory store and the Blueprint: input cleaning, tags, number clamping. */
import { randomBytes } from 'node:crypto';
import { redact } from './redact';
import type { DbResult } from './memory-model';

export function clean(v: unknown, max: number): { text: string | null; redactions: number } {
  if (v === undefined || v === null) return { text: null, redactions: 0 };
  const s = String(v).trim();
  if (!s) return { text: null, redactions: 0 };
  // Redact BEFORE truncating: a secret straddling the cut would otherwise be
  // shortened below its pattern's minimum length and be stored in part.
  const r = redact(s);
  const text = r.text.length > max ? r.text.slice(0, max) + ' …[truncated]' : r.text;
  return { text, redactions: r.count };
}

export const MAX_TAG = 40;

export function toTags(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const t = arr
    .map((x) => (clean(x, MAX_TAG).text ?? '').toLowerCase()) // redact first: patterns are case-sensitive
    .filter(Boolean)
    .slice(0, 12);
  return t.length ? t.join(',') : null;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const affected = (rs: DbResult): number => Number((rs as any).rowsAffected ?? 0);
export const sameText = (a: unknown, b: unknown) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const batchId = (prefix: string) => prefix + randomBytes(4).toString('hex');
